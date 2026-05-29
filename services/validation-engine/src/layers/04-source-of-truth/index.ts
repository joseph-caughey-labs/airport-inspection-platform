/**
 * Layer 4 — Source-of-Truth Cross-Check.
 *
 * Asks reference-data whether the entities the detection names
 * actually exist:
 *   - payload.sensor_id → must resolve to a sensor row
 *   - payload.airport_id (if present) → must resolve to an airport row
 *
 * Skipped silently when no `ReferenceDataClient` is configured (the
 * default `ORDERED_LAYERS` path uses no client so the engine remains
 * usable in tests + bootstrap without a reference-data dependency).
 * Production wiring passes a real client in `app.ts`.
 *
 * L4 is the first layer that performs I/O. We still treat the layer
 * as pure in the sense that the result depends only on `ctx.payload`
 * + the client's responses; the orchestrator's metrics + the audit
 * trail capture per-layer timings.
 */
import type { ValidationLayer } from "../types.js";
import type { ReferenceDataClient } from "../../reference/client.js";

export interface SourceOfTruthConfig {
  /** Reference-data lookups. When omitted, L4 passes through. */
  client?: ReferenceDataClient;
}

interface RefFailure {
  code: string;
  message: string;
  field?: string;
  value?: unknown;
}

export function createSourceOfTruthLayer(cfg: SourceOfTruthConfig = {}): ValidationLayer {
  const client = cfg.client;

  return {
    id: "04_source_of_truth",
    name: "Source-of-Truth Cross-Check",
    async run(ctx) {
      if (!client) {
        return { layer: "04_source_of_truth", passed: true };
      }
      const ids = extractIds(ctx.payload);
      if (!ids) return { layer: "04_source_of_truth", passed: true };

      const failures: RefFailure[] = [];

      if (ids.sensor_id) {
        const sensor = await client.getSensorById(ids.sensor_id);
        if (sensor === null) {
          failures.push({
            code: "SENSOR_NOT_FOUND",
            message: `sensor_id "${ids.sensor_id}" not present in reference-data`,
            field: "payload.sensor_id",
            value: ids.sensor_id,
          });
        }
      }
      if (ids.airport_id) {
        const airport = await client.getAirportById(ids.airport_id);
        if (airport === null) {
          failures.push({
            code: "AIRPORT_NOT_FOUND",
            message: `airport_id "${ids.airport_id}" not present in reference-data`,
            field: "payload.airport_id",
            value: ids.airport_id,
          });
        }
      }

      if (failures.length === 0) {
        return { layer: "04_source_of_truth", passed: true };
      }
      const primary = failures[0]!;
      return {
        layer: "04_source_of_truth",
        passed: false,
        error_code: primary.code,
        error_message: primary.message,
        details: { failures },
      };
    },
  };
}

export const sourceOfTruthLayer: ValidationLayer = createSourceOfTruthLayer();

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
