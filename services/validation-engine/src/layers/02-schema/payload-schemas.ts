/**
 * Wire-format payload schemas that L2 validates AI detection +
 * sensor frame events against. These are the engine's *own* zod
 * mirrors of what the publishers in `services/ai-inference` (Python
 * pydantic) and `services/sensor-gateway` actually emit on Redis.
 *
 * Why local instead of pulled from `@aip/shared-contracts`?
 *
 *   - The existing `DetectionClass` enum in shared-contracts uses
 *     long names (`pavement_crack`, `snowbank_violation`,
 *     `surface_anomaly`) that the live AI publisher does NOT emit
 *     — the wire carries the short publisher names (`crack`,
 *     `snowbank`, `anomaly`). That mismatch is real (see drift
 *     between `services/ai-inference/src/models/events.py` and
 *     `packages/shared-contracts/src/enums/detection-class.ts`) but
 *     reconciling it is its own ticket. L2 has to validate what's
 *     actually on the wire, so we keep the validator-side schemas
 *     here.
 *   - The existing TS `SensorFramePayload` matches the wire shape
 *     and is re-used directly.
 */
import { z } from "zod";
import { SensorFramePayload } from "@aip/shared-contracts";

/** Re-export for downstream call sites that don't want to know about
 * the shared-contracts re-export path. */
export { SensorFramePayload };

/**
 * Wire-format detection classes — what the Python publisher actually
 * emits in `payload.detection_class`. Source of truth:
 * `services/ai-inference/src/models/events.py::DetectionClass`.
 */
export const WireDetectionClass = z.enum(["fod", "crack", "snowbank", "wildlife", "anomaly"]);
export type WireDetectionClass = z.infer<typeof WireDetectionClass>;

export const WireSeverityHint = z.enum(["critical", "high", "medium", "low", "info"]);
export type WireSeverityHint = z.infer<typeof WireSeverityHint>;

/**
 * Normalized image-space bounding box [0,1] in both axes. `w` and `h`
 * are strictly positive because a zero-width box is meaningless.
 */
export const BoundingBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});
export type BoundingBox = z.infer<typeof BoundingBox>;

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  alt_m: z.number().optional(),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/**
 * One detection produced by an AI detector for a single frame.
 * Mirrors `DetectionPayload` in
 * `services/ai-inference/src/models/events.py`.
 *
 * Permissive on `metadata` (calibration trail, detector internals)
 * because each detector class carries different metadata shapes.
 */
export const AiDetectionPayload = z.object({
  detection_id: z.string().min(1),
  sensor_id: z.string().min(1).max(64),
  frame_id: z.string().min(1).max(128),
  detection_class: WireDetectionClass,
  confidence: z.number().min(0).max(1),
  severity_hint: WireSeverityHint,
  bbox: BoundingBox.optional(),
  captured_at: z.string().datetime(),
  geo: GeoPoint.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type AiDetectionPayload = z.infer<typeof AiDetectionPayload>;
