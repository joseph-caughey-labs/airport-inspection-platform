# ADR 0005: Idempotency, retries, and circuit breakers

- **Status**: Accepted
- **Date**: 2026-05-30
- **Owner**: SRE
- **Reviewers**: Principal Architect, Backend

## Context

Every distributed call in the platform — HTTP between services, Redis pub/sub, Postgres writes — has the same three failure modes: transient (retry will succeed), persistent (retry will not), and ambiguous (the call may have already happened). Hand-rolling retry logic at each call site produces drift: different backoffs, different attempt counts, different decisions about which status codes are retryable, no consistent way to fall back fast when a downstream is genuinely down.

We need a single, named policy that every call site adopts (or explicitly opts out of with a documented "no retry" rationale), and a circuit breaker that prevents a retry storm from amplifying a downstream outage.

Three threat models drive the policy:

1. **Bursty transient failures** (NAT reset, broker reconnect, GC pause). Retry with exponential backoff + jitter recovers — without a coordinated retry burst, the downstream avoids a thundering herd.
2. **Sustained downstream outage**. Retries become harm — they prolong the impact and load the failing dependency. A circuit breaker per dependency lets requests fail fast.
3. **Re-delivery** (ioredis pmessage replay, outbox worker resume, operator retry). Side-effectful calls must be safe to repeat — idempotency keys on every write API + dedup windows on every subscriber.

## Decision

### Retries (`packages/http-client`)

- **`createHttpClient`** defaults: `retries: 3` (up to 4 attempts total), `retryBackoffMs: 100`, `retryMaxBackoffMs: 5000`, `jitter: true` (50%–150% of computed backoff).
- **`isRetryableStatus`** classifies HTTP status codes:
  - retry: `408`, `429`, `5xx`
  - no-retry: `2xx`, `3xx`, `4xx` (except the two above)
  - This list is the source of truth; per-call-site overrides are forbidden — a service that wants a different policy declares a separate client.
- **Network / timeout errors** retry up to `retries`. Each attempt has its own `timeoutMs` (default 5s); the retry loop is bounded by attempt count, not wall-clock.
- **Per-call-site retry policy is declared by constructing the client.** A site that doesn't want retries constructs `createHttpClient({ ..., retries: 0 })` with a doc-comment explaining why (most often: the call is side-effectful and no idempotency key is in scope).

### Circuit breaker (`packages/http-client`)

- **One `CircuitBreaker` per downstream service / external API.** Construct it once and share it across every client pointed at that target. A global breaker would tie unrelated failures together; per-call-site breakers would re-count the same outage as multiple separate incidents.
- **Defaults**: `failureThreshold: 5`, `resetTimeoutMs: 30_000`. States: `closed` → `open` (after threshold) → `half_open` (after resetTimeout) → `closed` on probe success.
- **The breaker counts a request as ONE failure when its retry loop exhausts** — not per attempt. `failureThreshold: 5` then means "5 consecutive logical failing requests", which is what an on-call's alert should fire on.
- **Open-state requests fail immediately** with `HttpClientError("circuit_open")` — no retries, no sleep. The caller falls back fast (cache, degraded response, DLQ).

### Redis (`packages/redis-client`)

- **ioredis built-in retry** is the policy. `createRedis` configures:
  - `retryStrategy`: exponential backoff (100ms → 5s cap), max 20 reconnect attempts. After 20 the strategy returns `null` and ioredis surfaces a hard failure to the caller.
  - `maxRetriesPerRequest: 3` — per-command retry for transient failures.
  - `enableReadyCheck: true` — surface connection issues at startup, not silently in production.
- **No custom circuit breaker for Redis.** ioredis's connection-state model (`connecting` / `ready` / `reconnecting` / `end`) already provides the fail-fast signal; downstream services check it via `redis.status` when needed.
- **Pub/sub requires a separate client.** Every service that subscribes uses a dedicated `createRedis()` connection for the subscriber path (a hard constraint of ioredis), keeping the command client free for `PUBLISH` / `PING` / etc.

### Idempotency

- **Every write API enforces an `idempotency_key`.**
  - `POST /incidents` (incident-service) collapses duplicate POSTs via the partial-unique index on `idempotency_key` in `0001_initial.sql`. Repeat returns the originally-created row.
  - Domain event envelopes carry an `idempotency_key` derived from the natural id: `detection:<sensor>:<frame>:<class>` for AI detections, `transition:<incident>:<command>` for state transitions.
- **Subscribers dedupe on receipt.**
  - `event-pipeline` has a `DedupStore` with a configurable window (default 5s).
  - `notification-service` has an LRU window on `event_id` (default 1000 ids).
  - `audit-service` relies on the unique constraint on `audit_events.event_id` to surface a re-INSERT as a constraint violation that the subscriber logs + counts.
- **DLQ for non-retryable failures.** Already in place:
  - `event-pipeline`'s `ReplayQueue` for `late_beyond_window` frames (T-415).
  - `notification-service`'s in-memory webhook DLQ for failed POSTs after retries exhaust (T-413).
  - `event-pipeline`'s `event_outbox` for at-least-once publish to the WS fanout (T-208).

## Alternatives considered

- **Per-call-site retry logic**. Rejected — drift across services, no single place to tune jitter, no shared error-code classification. The shared client lets us change the platform-wide policy in one PR.
- **Global circuit breaker across all downstream calls**. Rejected — a failing `audit-service` would open the breaker for `reference-data` too. Per-dependency breakers isolate failures.
- **Per-attempt circuit breaker accounting**. Rejected — 5 attempts of one logical request burns the breaker on a single outage burst. Per-logical-request counting matches the operational mental model ("how many requests failed?").
- **Retries on side-effectful endpoints without idempotency keys**. Rejected — risks duplicate state changes. Sites without idempotency in scope must declare `retries: 0`.
- **A custom Redis circuit breaker on top of ioredis**. Rejected — duplicates the connection-state model ioredis already exposes. The on-call's signal for a Redis outage is the connection status, not a wrapping breaker's gauge.

## Trade-offs

- **Lost**: per-call-site retry tuning. A consumer that wants a 30-second backoff or a 100-attempt loop has to make the case for a separate client.
- **Lost**: a single global circuit breaker dashboard. Operators need to look per-dependency.
- **Kept**: one source of truth for retryable status codes; one policy for jitter; per-dependency outage isolation; explicit "no retry" rationale at every opt-out site.

## Consequences

- New services constructing `createHttpClient` get the defaults automatically — no copy-paste of retry loops.
- The breaker is opt-in (`breaker?: CircuitBreaker`). A future PR that wires validation-engine ↔ reference-data (deferred from T-409) constructs `new CircuitBreaker({ name: "reference-data" })` once at startup and threads it into every reference-data-targeting client.
- The DLQ pattern from `notification-service` becomes the template: any new outbound subscriber that needs at-least-once delivery follows the same shape (retry → final failure → DLQ row with `attempts`, `error`, `completed_at`).
- The Redis subscriber dedup window is per-service. A new subscriber that wants stronger guarantees (cross-process, cross-restart) backs the window with Redis `SETEX` keyed on the envelope's `event_id` — the in-memory LRU is the demo's starting shape, not the ceiling.

## Production evolution path

- **Distributed circuit breaker state.** Today each instance has its own breaker. At scale, a shared Redis-backed breaker (or a service-mesh sidecar like Envoy / Linkerd) coordinates the trip across the cluster so one failing pod doesn't have to discover the outage independently.
- **Adaptive backoff.** Replace fixed exponential with a feedback-driven backoff (AIMD / token-bucket against the breaker's recent error rate).
- **Idempotency-key persistence layer.** A dedicated `idempotency_records` table that every write API checks first, with a 7-day TTL — covers the case where the natural-id-derived key collides with itself across restarts.
- **OpenTelemetry-instrumented retries.** Tag every retry attempt as a child span with the attempt number + reason, so a slow downstream's tail-latency surfaces as a clear "this took 4 retries to succeed" in the trace.
- **DLQ replay UI.** Today operators read the DLQ via `GET /deliveries/dlq`; a replay endpoint that re-enqueues with a fresh attempt count + a back-pressure-aware cadence becomes valuable when the DLQ rows grow beyond what an operator can hand-process.
