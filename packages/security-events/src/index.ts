/**
 * Security audit events (T-506).
 *
 * Emitted by services on every security-relevant action so the
 * audit-service hash-chain captures who-did-what-when even for
 * actions that don't already produce a domain event (login,
 * 401/403 trips, rate-limit blocks).
 *
 * Event_type taxonomy — `auth.*` for actions on the user identity,
 * `access.denied` for downstream protected-route denials,
 * `rate_limit.blocked` for the 429 path:
 *
 *   auth.login.succeeded          — user authenticated, tokens issued
 *   auth.login.failed             — email lookup failed (no such user)
 *   auth.refresh.succeeded        — access token swapped via refresh
 *   auth.refresh.failed           — refresh token rejected (expired / wrong kind / bad signature)
 *   auth.logout                   — user signed out (frontend-initiated; here for completeness)
 *   access.denied                 — 401 or 403 on a protected route
 *   rate_limit.blocked            — @fastify/rate-limit budget exceeded
 *
 * Channel: published on Redis `events.security.<event_type>` so the
 * audit-service can `psubscribe("events.security.*")` and write
 * each one as an `audit_events` row. The pattern mirrors the
 * existing `incident.transition.*` subscriber.
 *
 * Why a shared package and not inline: api-gateway is the primary
 * publisher today but downstream services may want to emit
 * `access.denied` themselves when their own `requireRole` trips. A
 * shared envelope keeps the audit-side subscriber's parser simple.
 */
import { type Logger } from "@aip/logger";
import { type RedisClient } from "@aip/redis-client";
import type { Role } from "@aip/shared-contracts";
import { randomUUID } from "node:crypto";
import { Counter, type Registry } from "prom-client";

export const SECURITY_EVENT_TYPES = [
  "auth.login.succeeded",
  "auth.login.failed",
  "auth.refresh.succeeded",
  "auth.refresh.failed",
  "auth.logout",
  "access.denied",
  "rate_limit.blocked",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/**
 * Common envelope every security event carries. `actor_user_id` is
 * the authenticated user when one was identified — null on a failed
 * login (no user exists), null on an unauthenticated 401, populated
 * on a 403 (user identified, role insufficient).
 *
 * `subject_id` is the entity the action targets — for auth.* it's
 * the same as actor_user_id; for access.denied / rate_limit.blocked
 * it's null (the subject is the route + IP, captured in payload).
 */
export interface SecurityEvent {
  event_id: string;
  event_type: SecurityEventType;
  schema_version: "v1";
  source: { service: string };
  timestamp: string;
  actor_user_id: string | null;
  subject_id: string | null;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export interface AuthLoginPayload {
  email: string;
  role?: Role;
  ip?: string;
  user_agent?: string;
  reason?: string;
}

export interface AuthRefreshPayload {
  ip?: string;
  user_agent?: string;
  reason?: string;
}

export interface AccessDeniedPayload {
  route: string;
  method: string;
  status: 401 | 403;
  ip?: string;
  reason?: string;
  required_roles?: Role[];
  actual_role?: Role;
}

export interface RateLimitBlockedPayload {
  route: string;
  method: string;
  ip: string;
  budget_per_minute?: number;
}

/** Channel name for a given event_type. Audit-service psubscribes to `events.security.*`. */
export function channelFor(eventType: SecurityEventType): string {
  return `events.security.${eventType}`;
}

export interface SecurityEventPublisher {
  emit(event: SecurityEvent): Promise<void>;
}

/**
 * Convenience builder — fills `event_id`, `timestamp`, and
 * `schema_version` so call sites just pass the action-specific
 * fields. Each emit-site uses this to keep the envelope shape
 * consistent.
 */
export interface BuildSecurityEventInput {
  event_type: SecurityEventType;
  source: { service: string };
  actor_user_id: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  correlation_id?: string;
  /** Override timestamp for tests with a fixed clock. */
  now?: () => string;
}

export function buildSecurityEvent(input: BuildSecurityEventInput): SecurityEvent {
  const now = input.now ?? (() => new Date().toISOString());
  const event: SecurityEvent = {
    event_id: randomUUID(),
    event_type: input.event_type,
    schema_version: "v1",
    source: input.source,
    timestamp: now(),
    actor_user_id: input.actor_user_id,
    subject_id: input.subject_id,
    payload: input.payload,
  };
  if (input.correlation_id) event.correlation_id = input.correlation_id;
  return event;
}

export interface RedisSecurityEventPublisherOptions {
  redis: RedisClient;
  logger: Logger;
  registry: Registry;
}

/**
 * Production publisher — writes to Redis on the
 * `events.security.<event_type>` channel. Failures are logged +
 * counted but NEVER thrown to the caller: a missed audit event is
 * a degradation, not a reason to fail the user-visible request.
 * This matches `RedisIncidentEventPublisher`'s posture.
 */
export class RedisSecurityEventPublisher implements SecurityEventPublisher {
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly metrics: {
    published: Counter<"event_type">;
    failures: Counter<"event_type">;
  };

  constructor(opts: RedisSecurityEventPublisherOptions) {
    this.redis = opts.redis;
    this.logger = opts.logger;
    this.metrics = {
      published: new Counter({
        name: "security_events_published_total",
        help: "Security audit events published on Redis.",
        labelNames: ["event_type"] as const,
        registers: [opts.registry],
      }),
      failures: new Counter({
        name: "security_events_publish_failures_total",
        help: "Security event publish failures.",
        labelNames: ["event_type"] as const,
        registers: [opts.registry],
      }),
    };
  }

  async emit(event: SecurityEvent): Promise<void> {
    const channel = channelFor(event.event_type);
    try {
      await this.redis.publish(channel, JSON.stringify(event));
      this.metrics.published.labels(event.event_type).inc();
    } catch (err) {
      this.metrics.failures.labels(event.event_type).inc();
      this.logger.error(
        {
          channel,
          event_id: event.event_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "security event publish failed",
      );
      // Don't rethrow — degradation, not user-visible failure.
    }
  }
}

/**
 * In-memory publisher for unit tests. Records every emitted event
 * in `published` so tests can assert without a real Redis.
 */
export class RecordingSecurityEventPublisher implements SecurityEventPublisher {
  readonly published: SecurityEvent[] = [];
  async emit(event: SecurityEvent): Promise<void> {
    this.published.push(event);
  }
}
