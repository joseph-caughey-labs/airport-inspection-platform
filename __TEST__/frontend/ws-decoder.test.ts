import { describe, expect, it } from "vitest";
import { alertFromSensorFrame, decodeWsFrame } from "~/utils/ws-decoder";
import type { SensorFrameMessage } from "~/types/ws";

const validSensorFrame = JSON.stringify({
  type: "sensor.frame.captured",
  schema_version: "v1",
  timestamp: "2026-05-28T10:00:00.000Z",
  last_event_id: "11111111-2222-3333-4444-555555555555",
  payload: {
    sensor_id: "CAM-RWY10L-01",
    sensor_type: "camera",
    frame_id: "CAM-RWY10L-01-00000001",
    captured_at: "2026-05-28T10:00:00.000Z",
    geo: { lat: 37.6213, lng: -122.379, alt_m: 4 },
    metadata: { w: 1920, h: 1080 },
  },
});

const validPresenceSnapshot = JSON.stringify({
  type: "presence.snapshot",
  schema_version: "v1",
  timestamp: "2026-05-28T10:00:00.000Z",
  payload: {
    airport_id: "11111111-1111-1111-1111-aaaaaaaaaaaa",
    count: 1,
    subscribers: [
      {
        connection_id: "abc-12345678",
        role: "operator",
        connected_at: "2026-05-28T09:59:00.000Z",
      },
    ],
  },
});

describe("decodeWsFrame", () => {
  it("returns kind=message for a valid sensor frame", () => {
    const r = decodeWsFrame(validSensorFrame);
    expect(r.kind).toBe("message");
    if (r.kind !== "message") return;
    expect(r.message.type).toBe("sensor.frame.captured");
  });

  it("returns kind=message for a valid presence.snapshot", () => {
    const r = decodeWsFrame(validPresenceSnapshot);
    expect(r.kind).toBe("message");
    if (r.kind !== "message") return;
    expect(r.message.type).toBe("presence.snapshot");
  });

  it("returns parse_error on malformed JSON", () => {
    const r = decodeWsFrame("{not json");
    expect(r.kind).toBe("parse_error");
  });

  it("returns parse_error when type field is missing", () => {
    const r = decodeWsFrame(JSON.stringify({ foo: 1 }));
    expect(r.kind).toBe("parse_error");
  });

  it("returns unknown_type for a known-string but unrecognized type", () => {
    const r = decodeWsFrame(
      JSON.stringify({ type: "ai.detection.fod", schema_version: "v1", payload: {} }),
    );
    expect(r.kind).toBe("unknown_type");
    if (r.kind === "unknown_type") expect(r.type).toBe("ai.detection.fod");
  });

  it("returns parse_error when a known type fails schema validation", () => {
    const r = decodeWsFrame(
      JSON.stringify({
        type: "sensor.frame.captured",
        schema_version: "v1",
        timestamp: "not-a-date",
        payload: { sensor_id: "x" },
      }),
    );
    expect(r.kind).toBe("parse_error");
  });
});

describe("alertFromSensorFrame", () => {
  const msg: SensorFrameMessage = {
    type: "sensor.frame.captured",
    schema_version: "v1",
    timestamp: "2026-05-28T10:00:00.000Z",
    last_event_id: "11111111-2222-3333-4444-555555555555",
    payload: {
      sensor_id: "CAM-1",
      sensor_type: "camera",
      frame_id: "F-1",
      captured_at: "2026-05-28T10:00:00.000Z",
      geo: { lat: 37.62, lng: -122.37 },
    },
  };
  const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";

  it("uses last_event_id as the alert id (stable across redeliveries)", () => {
    const a = alertFromSensorFrame(msg, AIRPORT);
    expect(a.id).toBe(msg.last_event_id);
  });

  it("falls back to frame_id when last_event_id is missing", () => {
    const trimmed: SensorFrameMessage = { ...msg };
    delete (trimmed as Partial<SensorFrameMessage>).last_event_id;
    const a = alertFromSensorFrame(trimmed, AIRPORT);
    expect(a.id).toBe("F-1");
  });

  it("assigns severity=info for sensor frames", () => {
    expect(alertFromSensorFrame(msg, AIRPORT).severity).toBe("info");
  });

  it("emits a detail string with sensor_type + sensor_id", () => {
    expect(alertFromSensorFrame(msg, AIRPORT).detail).toBe("camera · CAM-1");
  });

  it("preserves the supplied received_at", () => {
    const a = alertFromSensorFrame(msg, AIRPORT, "2026-05-28T11:00:00.000Z");
    expect(a.received_at).toBe("2026-05-28T11:00:00.000Z");
  });
});
