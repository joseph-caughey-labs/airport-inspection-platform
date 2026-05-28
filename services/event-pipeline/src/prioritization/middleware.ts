import { SensorFrameEvent } from "@aip/shared-contracts";
import { Counter, Histogram, type Registry } from "prom-client";
import { type ConsumerHandler } from "../consumers/types.js";
import { computeFramePriority, priorityTier } from "./priority.js";
import { type ReplayQueue } from "./replay-queue.js";
import { type WatermarkTracker } from "./watermark.js";

let priorityHistogram: Histogram<"tier"> | undefined;
let orderingCounter: Counter<"status"> | undefined;
let replayEnqueueCounter: Counter<"outcome"> | undefined;

function registerMetricsOnce(registry: Registry): {
  priority: Histogram<"tier">;
  ordering: Counter<"status">;
  replay: Counter<"outcome">;
} {
  if (!priorityHistogram) {
    priorityHistogram = new Histogram({
      name: "frame_priority",
      help: "Computed priority value per processed sensor frame, labeled by tier.",
      labelNames: ["tier"] as const,
      buckets: [10, 30, 50, 60, 80, 90, 100],
      registers: [registry],
    });
  }
  if (!orderingCounter) {
    orderingCounter = new Counter({
      name: "frame_order_total",
      help: "Frame ordering classifications: in_order / late_in_window / late_beyond_window.",
      labelNames: ["status"] as const,
      registers: [registry],
    });
  }
  if (!replayEnqueueCounter) {
    replayEnqueueCounter = new Counter({
      name: "replay_enqueue_total",
      help: "Replay-queue enqueue outcomes: accepted / dropped (queue full eviction).",
      labelNames: ["outcome"] as const,
      registers: [registry],
    });
  }
  return {
    priority: priorityHistogram,
    ordering: orderingCounter,
    replay: replayEnqueueCounter,
  };
}

export function _resetPrioritizationMetricsForTests(): void {
  priorityHistogram = undefined;
  orderingCounter = undefined;
  replayEnqueueCounter = undefined;
}

export interface PrioritizationMiddlewareOptions {
  watermark: WatermarkTracker;
  replayQueue: ReplayQueue;
  registry: Registry;
}

/**
 * Wrap a sensor-frame handler with prioritization + watermark
 * routing. Order of operations per message:
 *
 *  1. Parse the envelope (so we can read sensor_id and captured_at).
 *  2. Compute priority and observe it in the histogram.
 *  3. Classify ordering against the watermark.
 *  4. If `late_beyond_window`, enqueue for replay (no inner call).
 *  5. Otherwise pass through to the inner handler with priority on
 *     the log context.
 *
 * Parse failures bubble up unchanged — the orchestrator already
 * categorizes them via `consumer_errors_total`.
 */
export function withPrioritization(
  inner: ConsumerHandler,
  opts: PrioritizationMiddlewareOptions,
): ConsumerHandler {
  const metrics = registerMetricsOnce(opts.registry);
  return {
    name: inner.name,
    channel: inner.channel,
    async handle(rawPayload, ctx) {
      const event = SensorFrameEvent.parse(JSON.parse(rawPayload));
      const priority = computeFramePriority(event);
      const tier = priorityTier(priority);
      metrics.priority.labels(tier).observe(priority);

      const capturedAtMs = Date.parse(event.payload.captured_at);
      const status = opts.watermark.check(event.payload.sensor_id, capturedAtMs);
      metrics.ordering.labels(status).inc();

      if (status === "late_beyond_window") {
        const accepted = opts.replayQueue.enqueue(
          `${event.payload.sensor_id}:${event.payload.frame_id}`,
          rawPayload,
        );
        metrics.replay.labels(accepted ? "accepted" : "dropped").inc();
        ctx.logger.warn(
          {
            sensor_id: event.payload.sensor_id,
            frame_id: event.payload.frame_id,
            captured_at: event.payload.captured_at,
            watermark: opts.watermark.watermarkFor(event.payload.sensor_id),
            replay_outcome: accepted ? "accepted" : "dropped",
          },
          "frame routed to replay (late beyond window)",
        );
        return;
      }

      if (status === "late_in_window") {
        ctx.logger.info(
          {
            sensor_id: event.payload.sensor_id,
            frame_id: event.payload.frame_id,
            captured_at: event.payload.captured_at,
            watermark: opts.watermark.watermarkFor(event.payload.sensor_id),
          },
          "frame is late but within tolerance",
        );
      }

      await inner.handle(rawPayload, ctx);
    },
  };
}
