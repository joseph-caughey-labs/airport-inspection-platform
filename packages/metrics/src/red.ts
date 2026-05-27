import { Counter, Histogram } from "prom-client";
import type { Registry } from "./registry.js";

/** Standard duration buckets in seconds — tuned for HTTP/RPC surfaces. */
export const DEFAULT_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

export interface RedMetricsOptions {
  registry: Registry;
  /** Metric name prefix; default `http`. Results in `<prefix>_requests_total` etc. */
  prefix?: string;
  /**
   * Low-cardinality labels to attach to every metric. Required for any
   * "kind of request" dimension (method, route, status). Forbidden:
   * user ids, request ids, anything unbounded.
   */
  labels: readonly string[];
  /** Override histogram buckets. Default {@link DEFAULT_DURATION_BUCKETS}. */
  buckets?: readonly number[];
}

export interface RedMetrics {
  request: Counter<string>;
  error: Counter<string>;
  duration: Histogram<string>;
}

/**
 * Create the standard RED triple for any HTTP/RPC-like surface.
 *
 * - `<prefix>_requests_total` (Counter) — total requests.
 * - `<prefix>_errors_total` (Counter) — total error responses.
 * - `<prefix>_request_duration_seconds` (Histogram) — request duration.
 */
export function createRedMetrics({
  registry,
  prefix = "http",
  labels,
  buckets = DEFAULT_DURATION_BUCKETS,
}: RedMetricsOptions): RedMetrics {
  const labelNames = [...labels];
  return {
    request: new Counter({
      name: `${prefix}_requests_total`,
      help: `Total ${prefix} requests received`,
      labelNames,
      registers: [registry],
    }),
    error: new Counter({
      name: `${prefix}_errors_total`,
      help: `Total ${prefix} responses that resulted in error`,
      labelNames,
      registers: [registry],
    }),
    duration: new Histogram({
      name: `${prefix}_request_duration_seconds`,
      help: `${prefix} request duration in seconds`,
      labelNames,
      buckets: [...buckets],
      registers: [registry],
    }),
  };
}
