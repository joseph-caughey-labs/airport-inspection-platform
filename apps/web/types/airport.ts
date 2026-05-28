import { z } from "zod";

/**
 * Frontend seed-data schemas. These mirror the persisted shapes in
 * `/data/seed/*.json` and serve as the runtime + compile-time contract
 * for everything the map / alert feed / dashboards consume.
 *
 * NOT a copy of `db-schema` — the DB tables intentionally omit geo
 * fields until reference-data lands in Phase 3. The seed JSON is what
 * the frontend reads directly until then.
 */

export const Airport = z.object({
  id: z.string().uuid(),
  icao_code: z.string().min(3).max(4),
  iata_code: z.string().min(3).max(3),
  name: z.string(),
  city: z.string(),
  country: z.string(),
  timezone: z.string(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  default_zoom: z.number().min(1).max(22),
  created_at: z.string().datetime(),
});
export type Airport = z.infer<typeof Airport>;
export const AirportList = z.array(Airport);

export const Runway = z.object({
  id: z.string().uuid(),
  airport_id: z.string().uuid(),
  designator: z.string(),
  paired_designator: z.string(),
  length_m: z.number().positive(),
  width_m: z.number().positive(),
  surface: z.enum(["asphalt", "concrete", "grass", "gravel"]),
  status: z.enum(["open", "restricted", "closed"]),
  lat_start: z.number().min(-90).max(90),
  lng_start: z.number().min(-180).max(180),
  lat_end: z.number().min(-90).max(90),
  lng_end: z.number().min(-180).max(180),
  created_at: z.string().datetime(),
});
export type Runway = z.infer<typeof Runway>;
export const RunwayList = z.array(Runway);

export const Sensor = z.object({
  id: z.string(),
  airport_id: z.string().uuid(),
  type: z.enum(["camera", "lidar", "gps", "imu", "weather", "perimeter"]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  alt_m: z.number().optional(),
  status: z.enum(["online", "degraded", "offline"]),
  last_seen_at: z.string().datetime(),
  created_at: z.string().datetime(),
});
export type Sensor = z.infer<typeof Sensor>;
export const SensorList = z.array(Sensor);

export type SensorType = Sensor["type"];
export type SensorStatus = Sensor["status"];
