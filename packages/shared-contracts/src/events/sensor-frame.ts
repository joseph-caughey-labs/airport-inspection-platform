import { z } from "zod";
import { GeoPoint, SensorId } from "../domain/sensor.js";
import { SensorType } from "../enums/sensor-type.js";
import { EventEnvelope } from "./envelope.js";

/**
 * Payload of a single sensor frame. `metadata` is a per-sensor-type
 * grab bag (camera resolution, LiDAR point count, weather visibility,
 * etc.). Downstream consumers narrow the metadata shape based on
 * `sensor_type`; we keep the top-level schema permissive so the
 * envelope itself is stable across all sensor families.
 */
export const SensorFramePayload = z.object({
  sensor_id: SensorId,
  sensor_type: SensorType,
  frame_id: z.string().min(1).max(128),
  captured_at: z.string().datetime(),
  geo: GeoPoint,
  metadata: z.record(z.unknown()),
});
export type SensorFramePayload = z.infer<typeof SensorFramePayload>;

/**
 * Full event envelope for a captured sensor frame. `event_type` is a
 * literal so consumers can route on it without parsing the payload.
 * Channel: `sensor.frame.captured` (per @aip/redis-client convention).
 */
export const SensorFrameEvent = EventEnvelope.extend({
  event_type: z.literal("sensor.frame.captured"),
  payload: SensorFramePayload,
});
export type SensorFrameEvent = z.infer<typeof SensorFrameEvent>;
