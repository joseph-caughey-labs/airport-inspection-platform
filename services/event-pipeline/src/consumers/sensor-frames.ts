import { SensorFrameEvent } from "@aip/shared-contracts";
import { type ConsumerHandler } from "./types.js";

/**
 * Phase-2 baseline handler for `sensor.frame.captured`.
 *
 * Today: parse + log. Future tickets attach:
 *  - T-206 deduplication
 *  - T-207 prioritization + ordering
 *  - T-208 persistence + WS broadcast publish
 *
 * Throws a typed error on malformed payloads so the orchestrator
 * records it in `consumer_errors_total`.
 */
export const sensorFramesHandler: ConsumerHandler = {
  name: "sensor-frames",
  channel: "sensor.frame.captured",
  async handle(rawPayload, ctx) {
    let json: unknown;
    try {
      json = JSON.parse(rawPayload);
    } catch (err) {
      throw new Error(
        `malformed JSON on sensor.frame.captured: ${err instanceof Error ? err.message : "parse failure"}`,
      );
    }

    const parsed = SensorFrameEvent.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue ? issue.path.join(".") : "<root>";
      const message = issue?.message ?? "unknown";
      throw new Error(`schema violation at ${path}: ${message}`);
    }

    const event = parsed.data;
    ctx.logger.debug(
      {
        sensor_id: event.payload.sensor_id,
        sensor_type: event.payload.sensor_type,
        frame_id: event.payload.frame_id,
      },
      "sensor frame consumed",
    );
  },
};
