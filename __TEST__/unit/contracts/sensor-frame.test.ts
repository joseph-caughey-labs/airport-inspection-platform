import { describe, expect, it } from "vitest";
import {
  SensorFrameEvent,
  SensorFramePayload,
} from "../../../packages/shared-contracts/src/index.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const TS = "2026-05-28T10:00:00.000Z";

describe("SensorFramePayload", () => {
  const valid = {
    sensor_id: "CAM-RWY10L-01",
    sensor_type: "camera",
    frame_id: "CAM-RWY10L-01-00000001",
    captured_at: TS,
    geo: { lat: 37.6213, lng: -122.379 },
    metadata: { width: 1920, height: 1080 },
  };

  it("accepts a well-formed camera frame payload", () => {
    expect(SensorFramePayload.parse(valid).frame_id).toBe("CAM-RWY10L-01-00000001");
  });

  it("rejects malformed sensor_id", () => {
    expect(() => SensorFramePayload.parse({ ...valid, sensor_id: "cam_n_03" })).toThrow();
  });

  it("rejects unknown sensor_type", () => {
    expect(() => SensorFramePayload.parse({ ...valid, sensor_type: "microphone" })).toThrow();
  });

  it("rejects out-of-range geo", () => {
    expect(() => SensorFramePayload.parse({ ...valid, geo: { lat: 91, lng: 0 } })).toThrow();
  });

  it("rejects when captured_at is not ISO-8601", () => {
    expect(() => SensorFramePayload.parse({ ...valid, captured_at: "not a date" })).toThrow();
  });

  it("requires frame_id with length ≥ 1", () => {
    expect(() => SensorFramePayload.parse({ ...valid, frame_id: "" })).toThrow();
  });
});

describe("SensorFrameEvent", () => {
  const valid = {
    event_id: UUID,
    event_type: "sensor.frame.captured",
    schema_version: "v1",
    source: { service: "sensor-gateway" },
    timestamp: TS,
    payload: {
      sensor_id: "CAM-RWY10L-01",
      sensor_type: "camera",
      frame_id: "CAM-RWY10L-01-00000001",
      captured_at: TS,
      geo: { lat: 37.6213, lng: -122.379 },
      metadata: { width: 1920, height: 1080 },
    },
  };

  it("accepts a well-formed event envelope", () => {
    expect(SensorFrameEvent.parse(valid).event_type).toBe("sensor.frame.captured");
  });

  it("rejects when event_type is not the literal", () => {
    expect(() => SensorFrameEvent.parse({ ...valid, event_type: "sensor.frame.other" })).toThrow();
  });

  it("accepts optional correlation + idempotency keys", () => {
    expect(() =>
      SensorFrameEvent.parse({
        ...valid,
        correlation_id: UUID,
        idempotency_key: "frame:CAM-RWY10L-01-00000001",
      }),
    ).not.toThrow();
  });
});
