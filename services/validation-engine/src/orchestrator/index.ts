import { randomUUID } from "node:crypto";
import {
  ORDERED_LAYERS,
  type ValidationContext,
  type ValidationLayer,
  type ValidationLayerResult,
} from "../layers/index.js";

export interface ValidationRun {
  run_id: string;
  submission_id: string;
  started_at: string;
  finished_at: string;
  layers: ValidationLayerResult[];
  certified: boolean;
}

export interface OrchestratorOptions {
  /** Override the layer list (mostly for tests). */
  layers?: readonly ValidationLayer[];
  /**
   * If true, stop running further layers when a layer fails.
   * Default `false` for Phase 1 (we want to surface every stub result).
   * T-405 sets this to `true` for production short-circuit behavior.
   */
  shortCircuit?: boolean;
}

/**
 * Run all configured layers in order against `ctx` and return a
 * ValidationRun. With every layer stubbed `passed: true`, the result
 * is always `certified: true`; T-405..T-411 replace the stubs with
 * real logic and short-circuit semantics.
 */
export async function runValidation(
  payload: unknown,
  opts: OrchestratorOptions & { submission_id?: string } = {},
): Promise<ValidationRun> {
  const layers = opts.layers ?? ORDERED_LAYERS;
  const submission_id = opts.submission_id ?? randomUUID();
  const run_id = randomUUID();
  const started_at = new Date().toISOString();
  const results: ValidationLayerResult[] = [];

  for (const layer of layers) {
    const ctx: ValidationContext = {
      submission_id,
      payload,
      previous_results: results.slice(),
    };
    const result = await layer.run(ctx);
    results.push(result);
    if (opts.shortCircuit && !result.passed) break;
  }

  return {
    run_id,
    submission_id,
    started_at,
    finished_at: new Date().toISOString(),
    layers: results,
    certified: results.every((r) => r.passed),
  };
}
