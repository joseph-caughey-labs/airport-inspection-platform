import { Counter, Gauge, type Registry } from "prom-client";
import { ALLOW_ALL, type BroadcastClient, type ClientFilter } from "./types.js";

export interface RegistryOptions {
  registry: Registry;
  /** Default filter applied to every dispatch. Pluggable for T-504 RBAC. */
  filter?: ClientFilter;
}

/**
 * In-memory subscription map: airport_id → Set<BroadcastClient>.
 *
 * The registry is intentionally synchronous and ignorant of the
 * transport — `BroadcastClient` is a 2-method shim so unit tests pass
 * a plain object without a real WebSocket. The route module is what
 * adapts `@fastify/websocket` sockets into this shape.
 *
 * Metric design follows the event-pipeline convention: ONE labeled
 * metric set, registered once on the supplied registry. The `airport`
 * label is bounded by the number of airports onboarded (low cardinality).
 */
export class ChannelRegistry {
  private readonly clients = new Map<string, Set<BroadcastClient>>();
  private readonly filter: ClientFilter;
  private readonly metrics: {
    subscribers: Gauge<"airport">;
    dispatched: Counter<"airport">;
    dropped: Counter<"airport" | "reason">;
  };

  constructor(opts: RegistryOptions) {
    this.filter = opts.filter ?? ALLOW_ALL;
    this.metrics = {
      subscribers: new Gauge({
        name: "ws_broadcaster_subscribers",
        help: "Current number of WebSocket subscribers per airport channel.",
        labelNames: ["airport"] as const,
        registers: [opts.registry],
      }),
      dispatched: new Counter({
        name: "ws_broadcaster_dispatched_total",
        help: "WebSocket messages dispatched to subscribers per airport channel.",
        labelNames: ["airport"] as const,
        registers: [opts.registry],
      }),
      dropped: new Counter({
        name: "ws_broadcaster_dropped_total",
        help: "Frames not delivered (filter, send-error). Labeled by reason.",
        labelNames: ["airport", "reason"] as const,
        registers: [opts.registry],
      }),
    };
  }

  subscribe(airportId: string, client: BroadcastClient): void {
    let set = this.clients.get(airportId);
    if (!set) {
      set = new Set();
      this.clients.set(airportId, set);
    }
    set.add(client);
    this.metrics.subscribers.labels(airportId).set(set.size);
  }

  unsubscribe(airportId: string, client: BroadcastClient): void {
    const set = this.clients.get(airportId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) {
      this.clients.delete(airportId);
      this.metrics.subscribers.labels(airportId).set(0);
    } else {
      this.metrics.subscribers.labels(airportId).set(set.size);
    }
  }

  subscriberCount(airportId: string): number {
    return this.clients.get(airportId)?.size ?? 0;
  }

  /**
   * Dispatch a serialized WS payload to every subscriber of `airportId`
   * whose `(role, eventType)` passes the configured filter. A send()
   * exception drops that client from this dispatch only — the socket's
   * own close handler removes it from the registry.
   */
  dispatch(airportId: string, eventType: string, payload: string): { delivered: number } {
    const set = this.clients.get(airportId);
    if (!set || set.size === 0) return { delivered: 0 };
    let delivered = 0;
    for (const client of set) {
      if (!this.filter.allow(client.role, eventType)) {
        this.metrics.dropped.labels(airportId, "filtered").inc();
        continue;
      }
      try {
        client.send(payload);
        delivered++;
      } catch {
        this.metrics.dropped.labels(airportId, "send_error").inc();
      }
    }
    if (delivered > 0) this.metrics.dispatched.labels(airportId).inc(delivered);
    return { delivered };
  }
}
