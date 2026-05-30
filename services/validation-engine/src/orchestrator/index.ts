import { randomUUID } from "node:crypto";
import type { ValidationRun } from "@aip/shared-contracts";
import {
  ORDERED_LAYERS,
  type ValidationContext,
  type ValidationLayer,
  type ValidationLayerResult,
} from "../layers/index.js";
import { recordLayer, recordRun, type OrchestratorMetrics } from "./metrics.js";

export type { ValidationRun } from "@aip/shared-contracts";

export interface OrchestratorOptions {
  /** Override the layer list (mostly for tests). */
  layers?: readonly ValidationLayer[];
  /**
   * When true, the orchestrator stops at the first failing layer.
   *
   * Production default (set in `app.ts`) is `true`: once T-406+ ships
   * real layers, running the audit + certification layers after L1
   * has already rejected a payload would be wasted work AND would
   * pollute the audit trail with cascading false failures.
   *
   * Defaults to `false` when called directly — tests want to see
   * every layer's result.
   */
  shortCircuit?: boolean;
  /** Optional metrics sink; when set, each layer + run is counted. */
  metrics?: OrchestratorMetrics;
  /** Test seam: deterministic clock. */
  now?: () => Date;
}

/**
 * Run all configured layers in order against `ctx` and return a
 * `ValidationRun`. Threads `previous_results` to each subsequent
 * layer so e.g. `10_certification` can read what the earlier layers
 * decided.
 */
export async function runValidation(
  payload: unknown,
  opts: OrchestratorOptions & { submission_id?: string } = {},
): Promise<ValidationRun> {
  const layers = opts.layers ?? ORDERED_LAYERS;
  const submission_id = opts.submission_id ?? randomUUID();
  const run_id = randomUUID();
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const startMs = startedAt.getTime();
  const results: ValidationLayerResult[] = [];

  for (const layer of layers) {
    const ctx: ValidationContext = {
      submission_id,
      payload,
      previous_results: results.slice(),
    };
    const result = await layer.run(ctx);
    results.push(result);
    recordLayer(opts.metrics, result.layer, result.passed);
    if (opts.shortCircuit && !result.passed) break;
  }

  const finishedAt = now();
  const certified = results.every((r) => r.passed);
  recordRun(opts.metrics, certified, (finishedAt.getTime() - startMs) / 1000);

  return {
    run_id,
    submission_id,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    layers: results,
    certified,
  };
}

export { createOrchestratorMetrics, type OrchestratorMetrics } from "./metrics.js";
