import { z } from "zod";
import { SensorType } from "../enums/sensor-type.js";

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  alt_m: z.number().optional(),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

export const SensorStatus = z.enum(["online", "degraded", "offline"]);
export type SensorStatus = z.infer<typeof SensorStatus>;

/**
 * Sensor identifier — operational naming convention used by airport ops.
 *
 * Format: `TYPE-LOCATION-INDEX` where:
 *  - TYPE is an uppercase short code (CAM, LDR, GPS, IMU, WX, PRM).
 *  - LOCATION is an uppercase alphanumeric tag (e.g. N, S, RWY09L, T-B).
 *  - INDEX is a zero-padded integer.
 *
 * Examples: `CAM-N-03`, `LDR-RWY09L-01`, `WX-T1-02`.
 */
export const SensorId = z
  .string()
  .regex(
    /^[A-Z]{2,4}-[A-Z0-9]+-\d{2,3}$/,
    "Sensor id must be TYPE-LOCATION-INDEX (uppercase)",
  );
export type SensorId = z.infer<typeof SensorId>;

export const Sensor = z.object({
  id: SensorId,
  airport_id: z.string().uuid(),
  type: SensorType,
  location: GeoPoint,
  status: SensorStatus,
  last_seen_at: z.string().datetime().optional(),
  created_at: z.string().datetime(),
});
export type Sensor = z.infer<typeof Sensor>;
