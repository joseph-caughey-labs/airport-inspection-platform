import { Counter, type Registry } from "prom-client";
import { type ConsumerHandler } from "../consumers/types.js";
import { type DedupStore } from "./store.js";

/**
 * Extract the `idempotency_key` from a raw event payload without
 * doing a full schema parse. Returns null when JSON is malformed or
 * the field is missing — both cases skip dedup and let the inner
 * handler surface the error.
 */
export function extractIdempotencyKey(rawPayload: string): string | null {
  try {
    const obj: unknown = JSON.parse(rawPayload);
    if (typeof obj === "object" && obj !== null && "idempotency_key" in obj) {
      const k = (obj as { idempotency_key: unknown }).idempotency_key;
      if (typeof k === "string" && k.length > 0) return k;
    }
  } catch {
    // fall through
  }
  return null;
}

let suppressedCounter: Counter<"queue"> | undefined;

/**
 * Register (or fetch) the workspace-singleton suppressed counter.
 * Same idiom as the orchestrator: one metric, sliced by queue label.
 */
function suppressedFor(registry: Registry): Counter<"queue"> {
  if (suppressedCounter) return suppressedCounter;
  suppressedCounter = new Counter({
    name: "consumer_suppressed_total",
    help: "Messages suppressed by the dedup middleware (duplicate idempotency_key within the window).",
    labelNames: ["queue"] as const,
    registers: [registry],
  });
  return suppressedCounter;
}

/**
 * Reset the singleton — tests want a fresh counter per registry.
 */
export function _resetSuppressedCounterForTests(): void {
  suppressedCounter = undefined;
}

export interface DedupMiddlewareOptions {
  store: DedupStore;
  registry: Registry;
}

/**
 * Wrap a ConsumerHandler with idempotency-key-based dedup. Duplicates
 * within the store's window are dropped (counted in
 * `consumer_suppressed_total{queue=<handler-name>}`); first-seen
 * messages flow through to the inner handler.
 *
 * Events missing an `idempotency_key` pass through unchanged — dedup
 * is opt-in via the envelope's presence of the field.
 */
export function withIdempotencyDedup(
  inner: ConsumerHandler,
  opts: DedupMiddlewareOptions,
): ConsumerHandler {
  const suppressed = suppressedFor(opts.registry);
  return {
    name: inner.name,
    channel: inner.channel,
    async handle(rawPayload, ctx) {
      const key = extractIdempotencyKey(rawPayload);
      if (key !== null) {
        if (opts.store.has(key)) {
          suppressed.labels(inner.name).inc();
          ctx.logger.info({ handler: inner.name, idempotency_key: key }, "duplicate suppressed");
          return;
        }
        opts.store.add(key);
      }
      await inner.handle(rawPayload, ctx);
    },
  };
}
