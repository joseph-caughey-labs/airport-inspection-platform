/**
 * Layer 5 — Cross-System Consistency Validation.
 *
 * Where L4 confirmed each referenced entity exists, L5 asks whether
 * their *relationships* are consistent:
 *
 *   - The detection's `payload.airport_id` (when present) matches
 *     the sensor's `airport_id` per reference-data. A mismatch means
 *     either the publisher is mis-labeling the airport or the sensor
 *     registration drifted — either way the operator UI shouldn't
 *     route this event without operator review.
 *
 *   - The sensor's `status` is not `offline` at capture time. An
 *     "offline" sensor producing detections is a contradiction worth
 *     flagging; degraded/online both pass.
 *
 * Skipped silently when no `ReferenceDataClient` is configured —
 * same default-pass semantics as L4 so tests + bootstrap stay green
 * without a live reference-data dependency.
 *
 * L5 deliberately re-fetches the sensor instead of reading L4's
 * `previous_results` evidence. Layer results stay independent and
 * the client implementation is responsible for caching when that
 * matters at scale.
 */
import type { ValidationLayer } from "../types.js";
import type { ReferenceDataClient, SensorReference } from "../../reference/client.js";

export interface CrossSystemConfig {
  client?: ReferenceDataClient;
}

interface CrossFailure {
  code: string;
  message: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
}

export function createCrossSystemLayer(cfg: CrossSystemConfig = {}): ValidationLayer {
  const client = cfg.client;

  return {
    id: "05_cross_system",
    name: "Cross-System Consistency Validation",
    async run(ctx) {
      if (!client) {
        return { layer: "05_cross_system", passed: true };
      }
      const ids = extractIds(ctx.payload);
      if (!ids?.sensor_id) {
        // Nothing to cross-check without at least a sensor reference.
        return { layer: "05_cross_system", passed: true };
      }
      const sensor = await client.getSensorById(ids.sensor_id);
      if (sensor === null) {
        // L4 already flagged this as SENSOR_NOT_FOUND; staying silent
        // here avoids double-failing the operator on the same issue.
        return { layer: "05_cross_system", passed: true };
      }

      const failures: CrossFailure[] = [];

      if (ids.airport_id && ids.airport_id !== sensor.airport_id) {
        failures.push(buildAirportMismatch(ids.airport_id, sensor));
      }

      if (sensor.status === "offline") {
        failures.push({
          code: "SENSOR_OFFLINE_AT_CAPTURE",
          message: `sensor ${sensor.id} is registered as offline but produced a detection`,
          field: "payload.sensor_id",
          actual: sensor.status,
          expected: "online | degraded",
        });
      }

      if (failures.length === 0) {
        return { layer: "05_cross_system", passed: true };
      }
      const primary = failures[0]!;
      return {
        layer: "05_cross_system",
        passed: false,
        error_code: primary.code,
        error_message: primary.message,
        details: { failures },
      };
    },
  };
}

export const crossSystemLayer: ValidationLayer = createCrossSystemLayer();

function buildAirportMismatch(payloadAirportId: string, sensor: SensorReference): CrossFailure {
  return {
    code: "SENSOR_AIRPORT_MISMATCH",
    message: `payload.airport_id ${payloadAirportId} does not match sensor ${sensor.id}'s airport ${sensor.airport_id}`,
    field: "payload.airport_id",
    expected: sensor.airport_id,
    actual: payloadAirportId,
  };
}

function extractIds(input: unknown): { sensor_id?: string; airport_id?: string } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const env = input as Record<string, unknown>;
  const payload = env.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  const out: { sensor_id?: string; airport_id?: string } = {};
  if (typeof p.sensor_id === "string") out.sensor_id = p.sensor_id;
  if (typeof p.airport_id === "string") out.airport_id = p.airport_id;
  return out;
}
