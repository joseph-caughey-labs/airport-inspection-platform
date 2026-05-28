import { type Logger } from "@aip/logger";
import { type Registry } from "@aip/metrics";
import { Counter, Gauge } from "prom-client";
import { type ConsumerHandler, type DispatchOutcome } from "./types.js";

export interface ConsumerOrchestratorOptions {
  /** Max concurrent in-flight handler invocations. Default 32. */
  maxConcurrency?: number;
  /** Prometheus registry for emitting RED + queue metrics. */
  registry: Registry;
  logger: Logger;
}

/**
 * Per-handler concurrency + metrics layer. Each dispatched message
 * either runs immediately (capacity available), succeeds/fails with
 * metrics, or is dropped under backpressure with a `dropped_total`
 * counter increment. The orchestrator never blocks the subscriber —
 * the subscriber sets the pace; the orchestrator sheds load loudly.
 *
 * Metric naming: `consumer_{depth, processed_total, errors_total,
 * dropped_total}` with a single `queue=<handler-name>` label. One
 * metric registration per registry; per-handler slices are label values.
 */
export class ConsumerOrchestrator {
  private readonly maxConcurrency: number;
  private readonly logger: Logger;
  private readonly inFlightByHandler = new Map<string, number>();

  private readonly metrics: {
    depth: Gauge<"queue">;
    processed: Counter<"queue">;
    errors: Counter<"queue">;
    dropped: Counter<"queue">;
  };

  constructor(opts: ConsumerOrchestratorOptions) {
    this.maxConcurrency = opts.maxConcurrency ?? 32;
    this.logger = opts.logger;

    const labelNames = ["queue"] as const;
    this.metrics = {
      depth: new Gauge({
        name: "consumer_depth",
        help: "Current in-flight handler count per queue (consumer name).",
        labelNames,
        registers: [opts.registry],
      }),
      processed: new Counter({
        name: "consumer_processed_total",
        help: "Messages successfully processed by a consumer.",
        labelNames,
        registers: [opts.registry],
      }),
      errors: new Counter({
        name: "consumer_errors_total",
        help: "Handler invocations that threw.",
        labelNames,
        registers: [opts.registry],
      }),
      dropped: new Counter({
        name: "consumer_dropped_total",
        help: "Messages shed under backpressure (in-flight ≥ maxConcurrency).",
        labelNames,
        registers: [opts.registry],
      }),
    };
  }

  private inFlight(handlerName: string): number {
    return this.inFlightByHandler.get(handlerName) ?? 0;
  }

  /**
   * Dispatch a single raw message to its handler. Returns the outcome
   * for test introspection; in production callers can fire-and-forget.
   */
  async dispatch(handler: ConsumerHandler, rawPayload: string): Promise<DispatchOutcome> {
    const inFlightNow = this.inFlight(handler.name);

    if (inFlightNow >= this.maxConcurrency) {
      this.metrics.dropped.labels(handler.name).inc();
      this.logger.warn(
        { handler: handler.name, in_flight: inFlightNow, max: this.maxConcurrency },
        "consumer dropped message under backpressure",
      );
      return "dropped";
    }

    this.inFlightByHandler.set(handler.name, inFlightNow + 1);
    this.metrics.depth.labels(handler.name).set(inFlightNow + 1);

    try {
      await handler.handle(rawPayload, { logger: this.logger });
      this.metrics.processed.labels(handler.name).inc();
      return "processed";
    } catch (err) {
      this.metrics.errors.labels(handler.name).inc();
      this.logger.error(
        {
          handler: handler.name,
          err: err instanceof Error ? err.message : String(err),
        },
        "consumer handler errored",
      );
      return "errored";
    } finally {
      const next = this.inFlight(handler.name) - 1;
      this.inFlightByHandler.set(handler.name, next);
      this.metrics.depth.labels(handler.name).set(next);
    }
  }
}
