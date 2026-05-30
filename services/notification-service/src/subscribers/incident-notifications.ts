/**
 * Subscribes to `incident.transition.*` (the same channel pattern
 * audit-service consumes from incident-service) and dispatches
 * each event through the channel registry.
 *
 * Idempotency: ioredis pmessage delivery is at-least-once, and the
 * publisher can also retry. We dedupe by `event_id` over a sliding
 * in-memory LRU sized for the demo's throughput. A real production
 * deployment would back this with Redis SETEX (out of scope here;
 * the same interface lets us swap implementations).
 *
 * Malformed messages are dropped + counted; the dispatch keeps
 * running so one bad publisher can't wedge the subscriber.
 */
import type { Logger } from "@aip/logger";
import type { RedisClient } from "@aip/redis-client";
import type { ChannelRegistry } from "../channels/registry.js";
import type { NotificationEvent } from "../channels/types.js";

export interface IncidentNotificationsSubscriberOptions {
  redis: RedisClient;
  registry: ChannelRegistry;
  logger: Logger;
  pattern?: string;
  /** Max event_ids retained for dedup. Default 1000. */
  idempotencyWindow?: number;
}

interface RawTransition {
  event_id?: unknown;
  event_type?: unknown;
  incident_id?: unknown;
  timestamp?: unknown;
  transition?: { reason?: unknown; occurred_at?: unknown } | unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IncidentNotificationsSubscriber {
  private readonly opts: Required<IncidentNotificationsSubscriberOptions>;
  private started = false;
  private dropped = 0;
  private duplicates = 0;
  private readonly seen: string[] = [];

  constructor(opts: IncidentNotificationsSubscriberOptions) {
    this.opts = {
      redis: opts.redis,
      registry: opts.registry,
      logger: opts.logger,
      pattern: opts.pattern ?? "incident.transition.*",
      idempotencyWindow: opts.idempotencyWindow ?? 1000,
    };
  }

  get droppedCount(): number {
    return this.dropped;
  }
  get duplicateCount(): number {
    return this.duplicates;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.opts.redis.on("pmessage", this.onPmessage);
    await this.opts.redis.psubscribe(this.opts.pattern);
    this.started = true;
    this.opts.logger.info({ pattern: this.opts.pattern }, "incident-notifications subscriber up");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.opts.redis.off("pmessage", this.onPmessage);
    await this.opts.redis.punsubscribe(this.opts.pattern);
    this.started = false;
  }

  /** Exposed for tests so a single message drives synchronously. */
  async handleMessage(_channel: string, raw: string): Promise<void> {
    const event = parse(raw);
    if (!event) {
      this.dropped += 1;
      return;
    }
    if (this.alreadySeen(event.event_id)) {
      this.duplicates += 1;
      return;
    }
    this.remember(event.event_id);
    await this.opts.registry.dispatch(event);
  }

  private readonly onPmessage = (_pattern: string, channel: string, message: string): void => {
    void this.handleMessage(channel, message).catch((err: unknown) => {
      this.opts.logger.error(
        { channel, err: err instanceof Error ? err.message : String(err) },
        "incident-notifications dispatch failed",
      );
    });
  };

  private alreadySeen(eventId: string): boolean {
    return this.seen.includes(eventId);
  }

  private remember(eventId: string): void {
    this.seen.push(eventId);
    if (this.seen.length > this.opts.idempotencyWindow) {
      this.seen.shift();
    }
  }
}

function parse(raw: string): NotificationEvent | undefined {
  let json: RawTransition;
  try {
    json = JSON.parse(raw) as RawTransition;
  } catch {
    return undefined;
  }
  if (json.event_type !== "incident.transitioned") return undefined;
  if (typeof json.incident_id !== "string" || !UUID_RE.test(json.incident_id)) return undefined;
  const eventId = typeof json.event_id === "string" ? json.event_id : json.incident_id;
  const transition =
    typeof json.transition === "object" && json.transition !== null
      ? (json.transition as { reason?: unknown; occurred_at?: unknown })
      : undefined;
  const occurredAt =
    typeof transition?.occurred_at === "string"
      ? transition.occurred_at
      : typeof json.timestamp === "string"
        ? json.timestamp
        : new Date().toISOString();
  const out: NotificationEvent = {
    event_id: eventId,
    event_type: "incident.transitioned",
    subject_id: json.incident_id,
    source: "incident-service",
    occurred_at: occurredAt,
    payload: json as unknown as Record<string, unknown>,
  };
  if (typeof transition?.reason === "string") {
    out.rationale = transition.reason;
  }
  return out;
}
