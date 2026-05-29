import { type Logger } from "@aip/logger";
import { type PgPool } from "@aip/postgres-client";
import { type RedisClient } from "@aip/redis-client";
import { Counter, type Registry } from "prom-client";

export interface AiDetectionBridgeOptions {
  /** Dedicated subscriber Redis client (separate from any publish/cmd one). */
  redis: RedisClient;
  /** Postgres pool — the bridge writes via the outbox, not directly to Redis. */
  pool: PgPool;
  logger: Logger;
  registry: Registry;
  /** Pattern to psubscribe; default matches every detection class. */
  pattern?: string;
  /** Channel prefix on the broadcast side. */
  broadcastChannelPrefix?: string;
  /**
   * Airport id used when the inbound detection envelope doesn't carry one.
   * The sensor → airport mapping lands in reference-data (T-306 reference-
   * data service); until then we fall back to the configured default.
   */
  defaultAirportId?: string;
}

interface RawEnvelope {
  event_type?: unknown;
  payload?: { sensor_id?: unknown; airport_id?: unknown } & Record<string, unknown>;
  idempotency_key?: unknown;
}

/**
 * Bridges AI detection events → operator broadcast.
 *
 * Subscribes to `ai.detection.*.emitted`, deduces the airport for the
 * detection, and writes the message verbatim to `event_outbox` with
 * channel `events.broadcast.<airport_id>`. The OutboxWorker then
 * publishes it to Redis, where ws-broadcaster picks it up and fans
 * it out to the operator dashboard.
 *
 * Why through the outbox? Two reasons:
 *   1. At-least-once durability — if Redis loses the message before
 *      a subscriber consumes it, we replay from `event_outbox`
 *      because the row stays `published_at IS NULL` until success.
 *   2. Single publish surface — every operator-facing broadcast goes
 *      through one channel taxonomy, makes the WS broadcaster's
 *      `psubscribe events.broadcast.*` pattern enough.
 *
 * Failure modes:
 *   - Malformed envelope → counted on `ai_detection_invalid_total`,
 *     dropped (we don't want to wedge the bridge on a single bad
 *     emit). The publisher's pydantic schema makes this rare; this
 *     is the defense-in-depth net.
 *   - Pg insert fails → throws to the caller's psubscribe loop;
 *     ioredis will redeliver on reconnect.
 */
export class AiDetectionBridge {
  private readonly opts: Required<AiDetectionBridgeOptions>;
  private readonly metrics: {
    bridged: Counter<"airport">;
    invalid: Counter<"reason">;
  };
  private started = false;

  constructor(opts: AiDetectionBridgeOptions) {
    if (!opts.defaultAirportId) {
      throw new Error("AiDetectionBridge requires defaultAirportId until reference-data lands");
    }
    this.opts = {
      redis: opts.redis,
      pool: opts.pool,
      logger: opts.logger,
      registry: opts.registry,
      pattern: opts.pattern ?? "ai.detection.*.emitted",
      broadcastChannelPrefix: opts.broadcastChannelPrefix ?? "events.broadcast",
      defaultAirportId: opts.defaultAirportId,
    };
    this.metrics = {
      bridged: new Counter({
        name: "ai_detection_bridged_total",
        help: "AI detection events bridged to the broadcast outbox.",
        labelNames: ["airport"] as const,
        registers: [opts.registry],
      }),
      invalid: new Counter({
        name: "ai_detection_invalid_total",
        help: "AI detection messages dropped before reaching the outbox.",
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
    this.opts.logger.info({ pattern: this.opts.pattern }, "ai-detection-bridge subscribed");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.opts.redis.off("pmessage", this.onPmessage);
    await this.opts.redis.punsubscribe(this.opts.pattern);
    this.started = false;
  }

  /** Exposed for tests so a single message can be driven synchronously. */
  async handleMessage(_channel: string, raw: string): Promise<void> {
    const parsed = this.parse(raw);
    if (parsed === undefined) {
      this.metrics.invalid.labels("malformed_payload").inc();
      return;
    }
    const airportId = parsed.airportId;
    const broadcastChannel = `${this.opts.broadcastChannelPrefix}.${airportId}`;
    await this.opts.pool.query(`INSERT INTO event_outbox (channel, payload) VALUES ($1, $2)`, [
      broadcastChannel,
      raw,
    ]);
    this.metrics.bridged.labels(airportId).inc();
  }

  private readonly onPmessage = (_pattern: string, channel: string, message: string): void => {
    // Don't await — the psubscribe loop must not block on slow
    // postgres inserts. The handler itself logs/counts errors.
    void this.handleMessage(channel, message).catch((err: unknown) => {
      this.metrics.invalid.labels("handler_error").inc();
      this.opts.logger.error(
        { err: err instanceof Error ? err.message : String(err), channel },
        "ai-detection-bridge handler failed",
      );
    });
  };

  private parse(raw: string): { airportId: string } | undefined {
    let json: RawEnvelope;
    try {
      json = JSON.parse(raw) as RawEnvelope;
    } catch {
      return undefined;
    }
    if (typeof json.event_type !== "string" || !json.event_type.startsWith("ai.detection.")) {
      return undefined;
    }
    if (typeof json.payload !== "object" || json.payload === null) {
      return undefined;
    }
    const payloadAirportId = json.payload.airport_id;
    if (typeof payloadAirportId === "string" && payloadAirportId.length > 0) {
      return { airportId: payloadAirportId };
    }
    return { airportId: this.opts.defaultAirportId };
  }
}
