import { type Logger } from "@aip/logger";
import { type RedisClient } from "@aip/redis-client";
import { Counter, type Registry } from "prom-client";
import { type ChannelRegistry } from "./channels/registry.js";

export interface RedisBridgeOptions {
  /** A DEDICATED subscriber Redis client (separate from the main publish/cmd one). */
  redis: RedisClient;
  logger: Logger;
  registry: Registry;
  channelRegistry: ChannelRegistry;
  /** Pattern to psubscribe; default matches the persist-handler's prefix. */
  pattern?: string;
  /** Channel-name prefix that fronts the airport id. */
  prefix?: string;
}

/**
 * Bridges Redis pub/sub → ChannelRegistry dispatch. Pattern-subscribes
 * to `events.broadcast.*` and routes each frame to the in-memory
 * subscriber set keyed by airport id.
 *
 * Payload contract: the persist-handler publishes the raw envelope
 * bytes that came off `sensor.frame.captured`. We pass them through
 * verbatim — the registry doesn't reparse, the client receives the
 * exact envelope it would have gotten via Redis if it were a service.
 *
 * Failure mode: malformed channel names (no airport segment) are
 * counted and dropped — they cannot be addressed and shouldn't crash
 * the bridge. The metric exists so a misconfiguration shows up loudly.
 */
export class RedisBridge {
  private readonly opts: Required<RedisBridgeOptions>;
  private readonly metrics: {
    received: Counter<"airport">;
    invalid: Counter<"reason">;
  };
  private started = false;

  constructor(opts: RedisBridgeOptions) {
    this.opts = {
      redis: opts.redis,
      logger: opts.logger,
      registry: opts.registry,
      channelRegistry: opts.channelRegistry,
      pattern: opts.pattern ?? "events.broadcast.*",
      prefix: opts.prefix ?? "events.broadcast",
    };
    this.metrics = {
      received: new Counter({
        name: "ws_broadcaster_received_total",
        help: "Frames received from Redis pattern subscription, per airport.",
        labelNames: ["airport"] as const,
        registers: [opts.registry],
      }),
      invalid: new Counter({
        name: "ws_broadcaster_invalid_total",
        help: "Malformed or unroutable pub/sub messages dropped at the bridge.",
        labelNames: ["reason"] as const,
        registers: [opts.registry],
      }),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.opts.redis.on("pmessage", this.onPmessage);
    await this.opts.redis.psubscribe(this.opts.pattern);
    this.started = true;
    this.opts.logger.info({ pattern: this.opts.pattern }, "ws-broadcaster bridge subscribed");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.opts.redis.off("pmessage", this.onPmessage);
    await this.opts.redis.punsubscribe(this.opts.pattern);
    this.started = false;
  }

  /** Exposed for tests so we can drive a single message synchronously. */
  handleMessage(channel: string, payload: string): void {
    const airportId = this.extractAirportId(channel);
    if (!airportId) {
      this.metrics.invalid.labels("missing_airport").inc();
      return;
    }
    const eventType = this.peekEventType(payload);
    if (!eventType) {
      this.metrics.invalid.labels("malformed_payload").inc();
      return;
    }
    this.metrics.received.labels(airportId).inc();
    this.opts.channelRegistry.dispatch(airportId, eventType, this.toWsEnvelope(payload, eventType));
  }

  private readonly onPmessage = (_pattern: string, channel: string, message: string): void => {
    this.handleMessage(channel, message);
  };

  private extractAirportId(channel: string): string | undefined {
    const prefix = `${this.opts.prefix}.`;
    if (!channel.startsWith(prefix)) return undefined;
    const tail = channel.slice(prefix.length);
    return tail.length > 0 ? tail : undefined;
  }

  private peekEventType(raw: string): string | undefined {
    try {
      const parsed = JSON.parse(raw) as { event_type?: unknown };
      return typeof parsed.event_type === "string" ? parsed.event_type : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Wraps the raw Redis envelope as a WS message so on-connect
   * hydration frames and live frames share one shape. We re-stringify
   * once; downstream clients parse exactly the same JSON either way.
   */
  private toWsEnvelope(raw: string, eventType: string): string {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify({
      type: eventType,
      schema_version:
        typeof parsed["schema_version"] === "string" ? parsed["schema_version"] : "v1",
      timestamp:
        typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : new Date().toISOString(),
      last_event_id: typeof parsed["event_id"] === "string" ? parsed["event_id"] : undefined,
      payload: parsed["payload"] ?? parsed,
    });
  }
}
