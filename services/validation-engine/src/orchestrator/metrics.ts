import { Counter, Histogram, type Registry } from "prom-client";
import type { ValidationLayerId } from "@aip/shared-contracts";

/**
 * Prom metrics emitted from the engine. One set per process — the
 * orchestrator threads them through `runValidation`. Production
 * dashboards (T-502) chart pass/fail by layer to spot regressions
 * after each fixture update.
 */
export interface OrchestratorMetrics {
  layersRun: Counter<"layer" | "passed">;
  runs: Counter<"certified">;
  duration: Histogram<"certified">;
}

export function createOrchestratorMetrics(registry: Registry): OrchestratorMetrics {
  return {
    layersRun: new Counter({
      name: "validation_layers_run_total",
      help: "Validation layers executed, labeled by id + pass/fail.",
      labelNames: ["layer", "passed"] as const,
      registers: [registry],
    }),
    runs: new Counter({
      name: "validation_runs_total",
      help: "Validation runs completed, labeled by certified=true|false.",
      labelNames: ["certified"] as const,
      registers: [registry],
    }),
    duration: new Histogram({
      name: "validation_run_duration_seconds",
      help: "Wall-clock duration of a full validation run.",
      labelNames: ["certified"] as const,
      // Sized for stub layers today (sub-ms) up to full Phase 4 runs
      // with audit + risk scoring (~hundreds of ms in worst case).
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
  };
}

/** Helper so the orchestrator doesn't need to know prom internals. */
export function recordLayer(
  metrics: OrchestratorMetrics | undefined,
  layer: ValidationLayerId,
  passed: boolean,
): void {
  metrics?.layersRun.labels(layer, passed ? "true" : "false").inc();
}

export function recordRun(
  metrics: OrchestratorMetrics | undefined,
  certified: boolean,
  durationSeconds: number,
): void {
  if (!metrics) return;
  metrics.runs.labels(certified ? "true" : "false").inc();
  metrics.duration.labels(certified ? "true" : "false").observe(durationSeconds);
}
