import { describe, expect, it } from "vitest";
import { alertFromDetection, decodeWsFrame, isLowConfidence } from "~/utils/ws-decoder";
import type { AiDetectionMessage } from "~/types/ws";

const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";

function buildDetection(overrides: Partial<AiDetectionMessage["payload"]> = {}): string {
  return JSON.stringify({
    type: "ai.detection.fod.emitted",
    schema_version: "v1",
    timestamp: "2026-05-28T10:00:00.000Z",
    last_event_id: "11111111-2222-3333-4444-555555555555",
    payload: {
      detection_id: "det-1",
      sensor_id: "CAM-RWY10L-01",
      frame_id: "F-1",
      detection_class: "fod",
      confidence: 0.87,
      severity_hint: "critical",
      bbox: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 },
      captured_at: "2026-05-28T10:00:00.000Z",
      geo: { lat: 37.62, lng: -122.37 },
      ...overrides,
    },
  });
}

describe("decodeWsFrame — AI detection envelopes", () => {
  it("returns kind=detection for a valid ai.detection.fod.emitted", () => {
    const r = decodeWsFrame(buildDetection());
    expect(r.kind).toBe("detection");
    if (r.kind !== "detection") return;
    expect(r.message.type).toBe("ai.detection.fod.emitted");
    expect(r.message.payload.detection_class).toBe("fod");
    expect(r.message.payload.confidence).toBeCloseTo(0.87);
  });

  it("accepts each canonical detection_class without rebuild", () => {
    for (const cls of ["fod", "crack", "snowbank", "wildlife", "anomaly"] as const) {
      const raw = JSON.stringify({
        type: `ai.detection.${cls}.emitted`,
        schema_version: "v1",
        timestamp: "2026-05-28T10:00:00.000Z",
        payload: {
          detection_id: `det-${cls}`,
          sensor_id: "CAM-1",
          frame_id: "F-1",
          detection_class: cls,
          confidence: 0.7,
          severity_hint: "medium",
          captured_at: "2026-05-28T10:00:00.000Z",
        },
      });
      const r = decodeWsFrame(raw);
      expect(r.kind).toBe("detection");
    }
  });

  it("returns parse_error when the detection payload violates the schema", () => {
    const raw = JSON.stringify({
      type: "ai.detection.fod.emitted",
      schema_version: "v1",
      timestamp: "2026-05-28T10:00:00.000Z",
      payload: {
        detection_id: "det-1",
        sensor_id: "CAM-1",
        frame_id: "F-1",
        detection_class: "fod",
        confidence: 1.5, // out of range
        severity_hint: "critical",
        captured_at: "2026-05-28T10:00:00.000Z",
      },
    });
    const r = decodeWsFrame(raw);
    expect(r.kind).toBe("parse_error");
  });

  it("returns parse_error when severity_hint is not in the enum", () => {
    const r = decodeWsFrame(buildDetection({ severity_hint: "fatal" as never }));
    expect(r.kind).toBe("parse_error");
  });

  it("returns unknown_type for ai.detection.* without the .emitted suffix", () => {
    const raw = JSON.stringify({
      type: "ai.detection.fod",
      schema_version: "v1",
      payload: {},
    });
    const r = decodeWsFrame(raw);
    expect(r.kind).toBe("unknown_type");
    if (r.kind === "unknown_type") {
      expect(r.type).toBe("ai.detection.fod");
    }
  });

  it("accepts detection with no bbox (boxes are optional)", () => {
    const raw = JSON.stringify({
      type: "ai.detection.snowbank.emitted",
      schema_version: "v1",
      timestamp: "2026-05-28T10:00:00.000Z",
      payload: {
        detection_id: "det-snow",
        sensor_id: "CAM-1",
        frame_id: "F-1",
        detection_class: "snowbank",
        confidence: 0.65,
        severity_hint: "medium",
        captured_at: "2026-05-28T10:00:00.000Z",
      },
    });
    const r = decodeWsFrame(raw);
    expect(r.kind).toBe("detection");
  });
});

describe("alertFromDetection", () => {
  it("uses last_event_id as the alert id", () => {
    const r = decodeWsFrame(buildDetection()) as Extract<
      ReturnType<typeof decodeWsFrame>,
      { kind: "detection" }
    >;
    const alert = alertFromDetection(r.message, AIRPORT);
    expect(alert.id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("falls back to detection_id when last_event_id is absent", () => {
    const raw = JSON.stringify({
      type: "ai.detection.fod.emitted",
      schema_version: "v1",
      timestamp: "2026-05-28T10:00:00.000Z",
      payload: {
        detection_id: "det-fallback",
        sensor_id: "CAM-1",
        frame_id: "F-1",
        detection_class: "fod",
        confidence: 0.8,
        severity_hint: "critical",
        captured_at: "2026-05-28T10:00:00.000Z",
      },
    });
    const r = decodeWsFrame(raw) as Extract<
      ReturnType<typeof decodeWsFrame>,
      { kind: "detection" }
    >;
    const alert = alertFromDetection(r.message, AIRPORT);
    expect(alert.id).toBe("det-fallback");
  });

  it("uses severity_hint from the payload, not derived from type", () => {
    const raw = buildDetection({ severity_hint: "low" });
    const r = decodeWsFrame(raw) as Extract<
      ReturnType<typeof decodeWsFrame>,
      { kind: "detection" }
    >;
    const alert = alertFromDetection(r.message, AIRPORT);
    expect(alert.severity).toBe("low");
  });

  it("formats the title with class + confidence percentage", () => {
    const raw = buildDetection({ confidence: 0.65, detection_class: "crack" });
    const r = decodeWsFrame(raw) as Extract<
      ReturnType<typeof decodeWsFrame>,
      { kind: "detection" }
    >;
    const alert = alertFromDetection(r.message, AIRPORT);
    expect(alert.title).toBe("CRACK detected · 65%");
  });

  it("threads airport_id and received_at through", () => {
    const r = decodeWsFrame(buildDetection()) as Extract<
      ReturnType<typeof decodeWsFrame>,
      { kind: "detection" }
    >;
    const alert = alertFromDetection(r.message, AIRPORT, "2026-05-28T11:00:00.000Z");
    expect(alert.airport_id).toBe(AIRPORT);
    expect(alert.received_at).toBe("2026-05-28T11:00:00.000Z");
  });
});

describe("isLowConfidence", () => {
  it("flags below the default 0.5 threshold", () => {
    const r = decodeWsFrame(buildDetection({ confidence: 0.45 })) as Extract<
      ReturnType<typeof decodeWsFrame>,
      { kind: "detection" }
    >;
    expect(isLowConfidence(r.message)).toBe(true);
  });

  it("does not flag at or above the default threshold", () => {
    const r = decodeWsFrame(buildDetection({ confidence: 0.5 })) as Extract<
      ReturnType<typeof decodeWsFrame>,
      { kind: "detection" }
    >;
    expect(isLowConfidence(r.message)).toBe(false);
  });

  it("honors a custom threshold", () => {
    const r = decodeWsFrame(buildDetection({ confidence: 0.7 })) as Extract<
      ReturnType<typeof decodeWsFrame>,
      { kind: "detection" }
    >;
    expect(isLowConfidence(r.message, 0.8)).toBe(true);
    expect(isLowConfidence(r.message, 0.6)).toBe(false);
  });
});
