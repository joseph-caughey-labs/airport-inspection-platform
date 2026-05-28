import { createLogger } from "@aip/logger";
import { describe, expect, it } from "vitest";
import { sensorFramesHandler } from "../../../services/event-pipeline/src/consumers/index.js";

const logger = createLogger({ service: "frame-handler-test", level: "fatal" });

const validEvent = {
  event_id: "11111111-2222-3333-4444-555555555555",
  event_type: "sensor.frame.captured",
  schema_version: "v1",
  source: { service: "sensor-gateway" },
  timestamp: "2026-05-28T10:00:00.000Z",
  payload: {
    sensor_id: "CAM-RWY10L-01",
    sensor_type: "camera",
    frame_id: "CAM-RWY10L-01-00000001",
    captured_at: "2026-05-28T10:00:00.000Z",
    geo: { lat: 37.6213, lng: -122.379 },
    metadata: { width: 1920, height: 1080 },
  },
};

describe("sensorFramesHandler", () => {
  it("processes a well-formed event without throwing", async () => {
    await expect(
      sensorFramesHandler.handle(JSON.stringify(validEvent), { logger }),
    ).resolves.toBeUndefined();
  });

  it("throws a typed error on malformed JSON", async () => {
    await expect(sensorFramesHandler.handle("{not json", { logger })).rejects.toThrow(
      /malformed JSON/,
    );
  });

  it("throws a typed error on schema violation", async () => {
    const bad = { ...validEvent, payload: { ...validEvent.payload, sensor_id: "bad-id" } };
    await expect(sensorFramesHandler.handle(JSON.stringify(bad), { logger })).rejects.toThrow(
      /schema violation/,
    );
  });

  it("rejects wrong event_type literal", async () => {
    const bad = { ...validEvent, event_type: "sensor.frame.other" };
    await expect(sensorFramesHandler.handle(JSON.stringify(bad), { logger })).rejects.toThrow(
      /schema violation/,
    );
  });

  it("subscribes to the canonical sensor.frame.captured channel", () => {
    expect(sensorFramesHandler.channel).toBe("sensor.frame.captured");
  });

  it("identifies itself as 'sensor-frames' for metrics", () => {
    expect(sensorFramesHandler.name).toBe("sensor-frames");
  });
});
