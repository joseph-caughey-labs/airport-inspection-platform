/**
 * Replay queue worker (T-415).
 *
 * The prioritization middleware enqueues frames classified
 * `late_beyond_window` into `ReplayQueue` instead of dispatching
 * them. They sit there until *this* worker drains them on an
 * interval and re-dispatches them straight to the persist handler.
 *
 * Bypassing the prioritization wrapper on re-dispatch is intentional:
 *
 *   - The frame was already classified once; re-running the
 *     watermark check here would just re-enqueue it forever (the
 *     watermark for the sensor advances as more recent frames flow,
 *     so the late frame stays past the tolerance window).
 *   - The replay path is the "we know this is late but worth
 *     processing" lane. The persistence layer is the safe target.
 *
 * Metrics:
 *
 *   - `replay_drained_total{outcome}`  ▶ drained items by terminal
 *     outcome — `processed` / `errored`.
 *   - `replay_dispatch_duration_seconds` histogram for visibility
 *     into how long persistence takes on the recovery path.
 *
 * The worker keeps a single `setInterval`; on shutdown `stop()`
 * waits for any in-flight tick to finish so we don't leave a half-
 * dispatched batch behind.
 */
import type { Logger } from "@aip/logger";
import { Counter, Histogram, type Registry } from "prom-client";
import type { ConsumerHandler } from "../consumers/types.js";
import type { ReplayQueue } from "../prioritization/replay-queue.js";

export interface ReplayQueueWorkerOptions {
  queue: ReplayQueue;
  /** Persist handler the prioritization wrapper would normally hand
   * the frame to. */
  handler: ConsumerHandler;
  logger: Logger;
  registry: Registry;
  /** How often to drain. Default 500ms — fast enough that a
   * recovered frame reaches the operator quickly without thrashing. */
  intervalMs?: number;
  /** Max items per tick. Default 50. */
  batchSize?: number;
  /** Test seam — defaults to setInterval / clearInterval. */
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_BATCH_SIZE = 50;

let drainedCounter: Counter<"outcome"> | undefined;
let dispatchDuration: Histogram | undefined;

function registerMetricsOnce(registry: Registry): {
  drained: Counter<"outcome">;
  duration: Histogram;
} {
  if (!drainedCounter) {
    drainedCounter = new Counter({
      name: "replay_drained_total",
      help: "Replay queue items processed by terminal outcome.",
      labelNames: ["outcome"] as const,
      registers: [registry],
    });
  }
  if (!dispatchDuration) {
    dispatchDuration = new Histogram({
      name: "replay_dispatch_duration_seconds",
      help: "Wall-clock duration of one replay dispatch.",
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    });
  }
  return { drained: drainedCounter, duration: dispatchDuration };
}

export function _resetReplayMetricsForTests(): void {
  drainedCounter = undefined;
  dispatchDuration = undefined;
}

export class ReplayQueueWorker {
  private readonly opts: Required<Omit<ReplayQueueWorkerOptions, "setInterval" | "clearInterval">>;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private timer: ReturnType<typeof globalThis.setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly metrics: { drained: Counter<"outcome">; duration: Histogram };

  constructor(opts: ReplayQueueWorkerOptions) {
    this.opts = {
      queue: opts.queue,
      handler: opts.handler,
      logger: opts.logger,
      registry: opts.registry,
      intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
      batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
    };
    this.setIntervalFn = opts.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = opts.clearInterval ?? globalThis.clearInterval;
    this.metrics = registerMetricsOnce(opts.registry);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalFn(() => {
      // Don't await — the interval callback should fire-and-forget
      // each tick. `inFlight` collapses overlapping ticks so a slow
      // persist handler can't queue up parallel drains.
      if (this.inFlight) return;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = undefined;
      });
    }, this.opts.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  /** Exposed so tests can drive a single drain pass synchronously. */
  async tick(): Promise<void> {
    const items = this.opts.queue.drain(this.opts.batchSize);
    if (items.length === 0) return;
    for (const item of items) {
      const end = this.metrics.duration.startTimer();
      try {
        await this.opts.handler.handle(item.payload, { logger: this.opts.logger });
        this.metrics.drained.labels("processed").inc();
      } catch (err) {
        this.metrics.drained.labels("errored").inc();
        this.opts.logger.error(
          {
            replay_key: item.key,
            err: err instanceof Error ? err.message : String(err),
          },
          "replay dispatch failed",
        );
      } finally {
        end();
      }
    }
  }
}
