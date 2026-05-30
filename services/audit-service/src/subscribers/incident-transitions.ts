/**
 * Subscribes to `incident.transition.*` Redis channels (published
 * by incident-service per T-403/T-404) and persists each one as an
 * `audit_events` row via the hash chain.
 *
 * Channel taxonomy: `incident.transition.<next_state>` —
 * `<next_state>` ∈ acknowledged|assigned|in_progress|resolved|
 * escalated|archived|rejected. Pattern subscription means a new
 * state added later is picked up automatically; the writer doesn't
 * need to know about state names.
 *
 * Mapping from the IncidentTransitionedEvent to an `audit_events`
 * row:
 *
 *   source        = "incident-service"
 *   event_type    = "incident.transitioned"
 *   subject_id    = incident_id
 *   actor_user_id = transition.actor (UUID; null when "system")
 *   payload       = the full event envelope
 *   correlation_id = correlation_id from the envelope (if present)
 *   rationale     = transition.reason
 *
 * Errors:
 *   - Malformed message → counted, dropped. The publisher's zod
 *     schema makes this rare; this is defense-in-depth.
 *   - DB INSERT failure → bubbles to the pmessage handler which
 *     logs + counts. ioredis redelivers on reconnect.
 */
import type { Logger } from "@aip/logger";
import type { RedisClient } from "@aip/redis-client";
import type { AuditChainWriter } from "../chain/writer.js";

export interface IncidentTransitionsSubscriberOptions {
  redis: RedisClient;
  writer: AuditChainWriter;
  logger: Logger;
  pattern?: string;
}

interface IncidentTransitionedEnvelope {
  event_type?: unknown;
  schema_version?: unknown;
  incident_id?: unknown;
  correlation_id?: unknown;
  transition?: {
    actor?: unknown;
    reason?: unknown;
    occurred_at?: unknown;
    to?: unknown;
    from?: unknown;
    command?: unknown;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IncidentTransitionsSubscriber {
  private readonly opts: Required<IncidentTransitionsSubscriberOptions>;
  private started = false;
  private dropped = 0;

  constructor(opts: IncidentTransitionsSubscriberOptions) {
    this.opts = {
      redis: opts.redis,
      writer: opts.writer,
      logger: opts.logger,
      pattern: opts.pattern ?? "incident.transition.*",
    };
  }

  /** Number of malformed messages dropped — exposed for tests + later metrics wiring. */
  get droppedCount(): number {
    return this.dropped;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.opts.redis.on("pmessage", this.onPmessage);
    await this.opts.redis.psubscribe(this.opts.pattern);
    this.started = true;
    this.opts.logger.info({ pattern: this.opts.pattern }, "audit subscriber up");
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
      this.opts.logger.warn({ channel }, "dropped malformed incident.transition.* message");
      return;
    }
    await this.opts.writer.append({
      source: "incident-service",
      event_type: "incident.transitioned",
      subject_id: parsed.incident_id,
      ...(parsed.actor ? { actor_user_id: parsed.actor } : { actor_user_id: null }),
      payload: parsed.envelope,
      ...(parsed.correlation_id ? { correlation_id: parsed.correlation_id } : {}),
      ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
      ...(parsed.occurred_at ? { occurred_at: parsed.occurred_at } : {}),
    });
  }

  private readonly onPmessage = (_pattern: string, channel: string, message: string): void => {
    void this.handleMessage(channel, message).catch((err: unknown) => {
      this.opts.logger.error(
        { channel, err: err instanceof Error ? err.message : String(err) },
        "audit subscriber INSERT failed",
      );
    });
  };
}

interface ParsedTransition {
  incident_id: string;
  actor: string | null;
  correlation_id?: string;
  rationale?: string;
  occurred_at?: string;
  envelope: Record<string, unknown>;
}

function parse(raw: string): ParsedTransition | undefined {
  let envelope: IncidentTransitionedEnvelope;
  try {
    envelope = JSON.parse(raw) as IncidentTransitionedEnvelope;
  } catch {
    return undefined;
  }
  if (envelope.event_type !== "incident.transitioned") return undefined;
  if (typeof envelope.incident_id !== "string" || !UUID_RE.test(envelope.incident_id)) {
    return undefined;
  }
  if (!envelope.transition || typeof envelope.transition !== "object") return undefined;
  const actor = typeof envelope.transition.actor === "string" ? envelope.transition.actor : null;
  const out: ParsedTransition = {
    incident_id: envelope.incident_id,
    actor: actor && UUID_RE.test(actor) ? actor : null,
    envelope: envelope as unknown as Record<string, unknown>,
  };
  if (typeof envelope.correlation_id === "string" && UUID_RE.test(envelope.correlation_id)) {
    out.correlation_id = envelope.correlation_id;
  }
  if (typeof envelope.transition.reason === "string") {
    out.rationale = envelope.transition.reason;
  }
  if (typeof envelope.transition.occurred_at === "string") {
    out.occurred_at = envelope.transition.occurred_at;
  }
  return out;
}
