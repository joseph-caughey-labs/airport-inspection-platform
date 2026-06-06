/**
 * Small shared helpers used across scenarios: a generic poller, plus
 * convenience reads of the event-pipeline consumer counters.
 */
import { scrape, sumWhere } from "./metrics.js";
import { sleep } from "./redis-load.js";
import type { ServiceName } from "./env.js";

/** Poll `fn` until it returns truthy or the timeout elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<T | undefined> {
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() >= deadline) return undefined;
    await sleep(interval);
  }
}

/** `consumer_processed_total{queue}` on event-pipeline (handler name = "sensor-frames"). */
export async function processedCount(queue = "sensor-frames"): Promise<number> {
  const samples = await scrape("event-pipeline");
  return sumWhere(samples, "consumer_processed_total", { queue });
}

/** `consumer_dropped_total{queue}` on event-pipeline. */
export async function droppedCount(queue = "sensor-frames"): Promise<number> {
  const samples = await scrape("event-pipeline");
  return sumWhere(samples, "consumer_dropped_total", { queue });
}

/** True if the service answers /metrics (liveness probe). */
export async function serviceLive(service: ServiceName): Promise<boolean> {
  try {
    await scrape(service);
    return true;
  } catch {
    return false;
  }
}
