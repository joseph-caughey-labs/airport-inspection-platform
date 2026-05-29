import { describe, expect, it } from "vitest";
import { alertFromDetection, decodeWsFrame } from "~/utils/ws-decoder";
import type { AiDetectionMessage } from "~/types/ws";

const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";

function buildDetection(overrides: Partial<AiDetectionMessage["payload"]> = {}): string {
  return JSON.stringify({
    type: "ai.detection.fod.emitted",
    schema_version: "v1",
    timestamp: "2026-05-28T10:00:00.000Z",
    last_event_id: "evt-1",
    payload: {
      detection_id: "det-1",
      sensor_id: "CAM-RWY10L-01",
      frame_id: "F-1",
      detection_class: "fod",
      confidence: 0.85,
      severity_hint: "critical",
      captured_at: "2026-05-28T10:00:00.000Z",
      ...overrides,
    },
  });
}

function decode(raw: string) {
  const r = decodeWsFrame(raw);
  if (r.kind !== "detection") throw new Error("expected detection");
  return r.message;
}

describe("alertFromDetection — low_confidence flag (T-311)", () => {
  it("omits low_confidence when confidence is high", () => {
    const msg = decode(buildDetection({ confidence: 0.85 }));
    const alert = alertFromDetection(msg, AIRPORT);
    expect(alert.low_confidence).toBeUndefined();
  });

  it("sets low_confidence=true when confidence is below 0.5", () => {
    const msg = decode(buildDetection({ confidence: 0.35 }));
    const alert = alertFromDetection(msg, AIRPORT);
    expect(alert.low_confidence).toBe(true);
  });

  it("treats 0.5 as the boundary (not low)", () => {
    const msg = decode(buildDetection({ confidence: 0.5 }));
    const alert = alertFromDetection(msg, AIRPORT);
    expect(alert.low_confidence).toBeUndefined();
  });

  it("title still reflects the raw percentage even when flagged low", () => {
    const msg = decode(buildDetection({ confidence: 0.3 }));
    const alert = alertFromDetection(msg, AIRPORT);
    expect(alert.title).toBe("FOD detected · 30%");
    expect(alert.low_confidence).toBe(true);
  });
});
