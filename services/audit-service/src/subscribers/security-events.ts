/**
 * Subscribes to `events.security.*` (published by api-gateway per
 * T-506) and writes each one as an `audit_events` row via the same
 * hash chain that captures `incident.transitioned` (T-412).
 *
 * Channel taxonomy: `events.security.<event_type>` —
 * `<event_type>` ∈ auth.login.succeeded | auth.login.failed |
 * auth.refresh.succeeded | auth.refresh.failed | auth.logout |
 * access.denied | rate_limit.blocked. Pattern subscription means a
 * new event type added later is picked up without touching this
 * file.
 *
 * Mapping from the SecurityEvent envelope to an `audit_events` row:
 *
 *   source        = envelope.source.service (e.g. "api-gateway")
 *   event_type    = envelope.event_type
 *   subject_id    = envelope.subject_id
 *   actor_user_id = envelope.actor_user_id (null for unauthenticated)
 *   payload       = full envelope (incl. ip, route, reason, etc.)
 *   correlation_id = envelope.correlation_id (request id)
 *
 * Errors:
 *   - Malformed message → counted, dropped. The publisher's builder
 *     enforces the shape; this is defense-in-depth.
 *   - DB INSERT failure → bubbles to the pmessage handler which
 *     logs + counts. ioredis redelivers on reconnect.
 *
 * Mirrors the design of `IncidentTransitionsSubscriber` — same
 * lifecycle (start / stop), same dropped-count surface, same
 * `handleMessage` test seam.
 */
import type { Logger } from "@aip/logger";
import type { RedisClient } from "@aip/redis-client";
import type { AuditChainWriter } from "../chain/writer.js";

export interface SecurityEventsSubscriberOptions {
  redis: RedisClient;
  writer: AuditChainWriter;
  logger: Logger;
  pattern?: string;
}

interface SecurityEventEnvelope {
  event_type?: unknown;
  schema_version?: unknown;
  source?: { service?: unknown };
  actor_user_id?: unknown;
  subject_id?: unknown;
  correlation_id?: unknown;
  timestamp?: unknown;
  payload?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SecurityEventsSubscriber {
  private readonly opts: Required<SecurityEventsSubscriberOptions>;
  private started = false;
  private dropped = 0;

  constructor(opts: SecurityEventsSubscriberOptions) {
    this.opts = {
      redis: opts.redis,
      writer: opts.writer,
      logger: opts.logger,
      pattern: opts.pattern ?? "events.security.*",
    };
  }

  /** Number of malformed messages dropped — exposed for tests + metrics. */
  get droppedCount(): number {
    return this.dropped;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.opts.redis.on("pmessage", this.onPmessage);
    await this.opts.redis.psubscribe(this.opts.pattern);
    this.started = true;
    this.opts.logger.info({ pattern: this.opts.pattern }, "security audit subscriber up");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.opts.redis.off("pmessage", this.onPmessage);
    await this.opts.redis.punsubscribe(this.opts.pattern);
    this.started = false;
  }

  /** Exposed for tests so a single message can be driven synchronously. */
  async handleMessage(channel: string, raw: string): Promise<void> {
    const parsed = parse(raw);
    if (!parsed) {
      this.dropped += 1;
      this.opts.logger.warn({ channel }, "dropped malformed events.security.* message");
      return;
    }
    await this.opts.writer.append({
      source: parsed.source,
      event_type: parsed.event_type,
      subject_id: parsed.subject_id,
      actor_user_id: parsed.actor_user_id,
      payload: parsed.envelope,
      ...(parsed.correlation_id ? { correlation_id: parsed.correlation_id } : {}),
      ...(parsed.occurred_at ? { occurred_at: parsed.occurred_at } : {}),
    });
  }

  private readonly onPmessage = (_pattern: string, channel: string, message: string): void => {
    void this.handleMessage(channel, message).catch((err: unknown) => {
      this.opts.logger.error(
        { channel, err: err instanceof Error ? err.message : String(err) },
        "security audit subscriber INSERT failed",
      );
    });
  };
}

interface ParsedSecurityEvent {
  source: string;
  event_type: string;
  actor_user_id: string | null;
  subject_id: string | null;
  correlation_id?: string;
  occurred_at?: string;
  envelope: Record<string, unknown>;
}

function parse(raw: string): ParsedSecurityEvent | undefined {
  let envelope: SecurityEventEnvelope;
  try {
    envelope = JSON.parse(raw) as SecurityEventEnvelope;
  } catch {
    return undefined;
  }
  if (typeof envelope.event_type !== "string") return undefined;
  if (envelope.schema_version !== "v1") return undefined;
  const service =
    envelope.source && typeof envelope.source.service === "string"
      ? envelope.source.service
      : undefined;
  if (!service) return undefined;

  // actor_user_id may legitimately be null (failed login, anon 401).
  let actor: string | null;
  if (envelope.actor_user_id === null) {
    actor = null;
  } else if (typeof envelope.actor_user_id === "string" && UUID_RE.test(envelope.actor_user_id)) {
    actor = envelope.actor_user_id;
  } else {
    return undefined;
  }

  let subject: string | null;
  if (envelope.subject_id === null) {
    subject = null;
  } else if (typeof envelope.subject_id === "string" && UUID_RE.test(envelope.subject_id)) {
    subject = envelope.subject_id;
  } else {
    return undefined;
  }

  const out: ParsedSecurityEvent = {
    source: service,
    event_type: envelope.event_type,
    actor_user_id: actor,
    subject_id: subject,
    envelope: envelope as unknown as Record<string, unknown>,
  };
  // correlation_id is the request id (uuid OR an arbitrary string —
  // pino's correlationHook uses uuid by default but tests sometimes
  // pass shorter strings). Accept any non-empty string.
  if (typeof envelope.correlation_id === "string" && envelope.correlation_id.length > 0) {
    out.correlation_id = envelope.correlation_id;
  }
  if (typeof envelope.timestamp === "string") {
    out.occurred_at = envelope.timestamp;
  }
  return out;
}
