import { Counter, Gauge } from "prom-client";
import type { Registry } from "./registry.js";

export interface QueueMetricsOptions {
  registry: Registry;
  /**
   * Logical queue name (e.g. "events.broadcast", "sensor.frames").
   * Becomes the `queue` label value on every metric.
   */
  name: string;
  /** Metric name prefix; default `queue`. */
  prefix?: string;
}

export interface QueueMetrics {
  /** Current queue depth (consumer-side, e.g. pending events). */
  depth: Gauge<string>;
  /** Items successfully processed (delta). */
  processed: Counter<string>;
  /** Items that failed processing (delta). */
  errors: Counter<string>;
  /** Items dropped due to backpressure (delta). */
  dropped: Counter<string>;
}

/**
 * Create the standard USE-ish metric set for any consumer surface
 * (Redis subscriber, worker pool, in-process queue).
 *
 * - `<prefix>_depth` (Gauge) — current pending items.
 * - `<prefix>_processed_total` (Counter) — successful handling deltas.
 * - `<prefix>_errors_total` (Counter) — failure deltas.
 * - `<prefix>_dropped_total` (Counter) — backpressure shedding deltas.
 */
export function createQueueMetrics({
  registry,
  name,
  prefix = "queue",
}: QueueMetricsOptions): QueueMetrics {
  const labelNames = ["queue"] as const;
  const baseLabels = { queue: name };
  return {
    depth: new Gauge({
      name: `${prefix}_depth`,
      help: `Current depth of the ${name} queue`,
      labelNames,
      registers: [registry],
    }).labels(baseLabels) as unknown as Gauge<string>,
    processed: new Counter({
      name: `${prefix}_processed_total`,
      help: `Total successfully processed items from the ${name} queue`,
      labelNames,
      registers: [registry],
    }).labels(baseLabels) as unknown as Counter<string>,
    errors: new Counter({
      name: `${prefix}_errors_total`,
      help: `Total processing errors from the ${name} queue`,
      labelNames,
      registers: [registry],
    }).labels(baseLabels) as unknown as Counter<string>,
    dropped: new Counter({
      name: `${prefix}_dropped_total`,
      help: `Total items dropped from the ${name} queue under backpressure`,
      labelNames,
      registers: [registry],
    }).labels(baseLabels) as unknown as Counter<string>,
  };
}
