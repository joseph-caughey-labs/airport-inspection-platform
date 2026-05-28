import { type SensorFrameEvent } from "@aip/shared-contracts";

/**
 * Sensor-id location tokens recognized by the priority function.
 * Mirrors the operational naming convention enforced by the schema
 * regex (`^[A-Z]{2,4}-[A-Z0-9]+-\d{2,3}$`). Tokens between the type
 * and the index encode the operational zone.
 *
 * Domain Expert vocabulary:
 *  - `RWY*` — on/near a runway. Highest priority.
 *  - `TWY*` — taxiway.
 *  - `APR*` — apron.
 *  - everything else — perimeter / generic / unknown.
 */
const LOCATION_BASE_PRIORITY: ReadonlyArray<{ test: RegExp; value: number }> = [
  { test: /-RWY/i, value: 100 },
  { test: /-TWY/i, value: 60 },
  { test: /-APR/i, value: 30 },
];

const SENSOR_TYPE_WEIGHT: Record<string, number> = {
  camera: 1.0,
  lidar: 1.0,
  perimeter: 0.8,
  weather: 0.5,
  gps: 0.3,
  imu: 0.3,
};

/**
 * Compute an integer priority for a sensor frame. Higher = process
 * first under backpressure. Combines sensor location (RWY / TWY /
 * APR / other) with sensor-type weight.
 *
 * Used in three places:
 *  1. Structured-log enrichment (every frame log carries a priority).
 *  2. Metrics label (so dashboards can break down throughput by tier).
 *  3. Future: real priority queue when consumers add ordered processing.
 */
export function computeFramePriority(event: SensorFrameEvent): number {
  const sensorId = event.payload.sensor_id;
  const sensorType = event.payload.sensor_type;
  const base = LOCATION_BASE_PRIORITY.find((rule) => rule.test.test(sensorId))?.value ?? 50;
  const weight = SENSOR_TYPE_WEIGHT[sensorType] ?? 0.5;
  return Math.round(base * weight);
}

/**
 * Coarse priority tier — used as a metric label (cardinality bounded
 * to four values to keep Prometheus happy).
 */
export function priorityTier(priority: number): "critical" | "high" | "medium" | "low" {
  if (priority >= 90) return "critical";
  if (priority >= 60) return "high";
  if (priority >= 30) return "medium";
  return "low";
}
