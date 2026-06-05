# Auth surface — operational guide

How a request is authenticated on the platform, where the budgets and gates live, what shows up on the audit chain, and what an oncall on shift should look at first when something goes sideways.

Pairs with [ADR 0011 — Input validation, JWT auth, and RBAC](../adr/0011-input-validation-and-auth.md), [ADR 0012 — api-gateway as the single public surface](../adr/0012-api-gateway-as-public-surface.md), and [ADR 0013 — Refresh-token revocation](../adr/0013-refresh-token-revocation.md). Read those for the _why_; this doc is the _what_ and the _where_.

## Token model

Two signed JWTs, both HS256, both minted by `@aip/auth-jwt`'s `createJwtSigner`:

| Token     | Default TTL | Claims            | Used by                                                          |
| --------- | ----------- | ----------------- | ---------------------------------------------------------------- |
| `access`  | 15 min      | `user_id`, `role` | Every protected request, sent as `Authorization: Bearer <token>` |
| `refresh` | 7 days      | `user_id`         | `POST /api/v1/auth/refresh` swaps it for a fresh `access`        |

Both also carry the standard `iss` (`aip-api-gateway` in prod), `iat`, `exp`, and a `kind` claim (`access` | `refresh`) that the verify path checks before trusting the payload — a refresh token presented as an access token, or vice versa, fails with `wrong_kind` rather than silently succeeding.

The signing secret is read from `JWT_SECRET` (32+ bytes, asserted at boot — `AuthJwtError("invalid_secret", ...)` is fatal). A test-only secret lives in `services/api-gateway/src/app.ts`; production wires the real value via env. The role on the access token means RBAC checks never need a DB lookup per request — the trade-off is that a role change only takes effect after the user's next refresh (acceptable for the demo).

## The request lifecycle

A protected request flows through three places, in order:

```
client → nginx → api-gateway → downstream service
                     │              │
                     │              └── verifyJwtHook + requireRole(...)
                     │
                     └── verifyJwtHook + (proxy or local route)
```

1. **nginx** routes `/api/v1/*` → api-gateway, `/ws/*` → ws-broadcaster, `/` → Nuxt. It does no auth itself — the public surface is the gateway.
2. **api-gateway** runs `verifyJwtHook` on every request (app-level `onRequest`). The hook reads `Authorization: Bearer <token>`, calls `signer.verifyAccess(token)`, and stamps `req.auth = { user_id, role }` when verification succeeds. **Verification failures here are silent** — `req.auth` stays undefined and the per-route helper decides whether to reject. Public routes (`/api/v1/auth/login`, `/api/v1/auth/refresh`, `/health`, `/ready`, `/metrics`) flow through unblocked.
3. **Downstream service** (audit-service, incident-service, etc.) re-runs the same `verifyJwtHook` on its inbound request and applies its own `requireRole(...rolesFor(permission))` preHandler. The Authorization header is forwarded by `@fastify/http-proxy` unchanged — defense in depth, not redundant work (see [ADR 0012](../adr/0012-api-gateway-as-public-surface.md) for the rationale).

The split between `verifyJwtHook` and `requireAuth` / `requireRole` is intentional: authentication runs once at the app level and attaches whatever's available; authorization runs per route and decides whether to reject. That keeps the auth posture obvious from each route file (`{ preHandler: requireRole("supervisor", "admin") }` reads as the contract).

## Public endpoints — the auth surface itself

`api-gateway` exposes three routes that don't require an access token:

| Endpoint                    | Purpose                     | Body                | Success         | Failure                                   |
| --------------------------- | --------------------------- | ------------------- | --------------- | ----------------------------------------- |
| `POST /api/v1/auth/login`   | Email → token pair          | `{ email }`         | `200` + tokens  | `401 unauthorized` (no such user)         |
| `POST /api/v1/auth/refresh` | Refresh → fresh access      | `{ refresh_token }` | `200` + access  | `401 unauthorized` (4 reasons, see below) |
| `POST /api/v1/auth/logout`  | Revoke refresh, end session | `{ refresh_token }` | `204` (no body) | `401` on malformed token                  |

Refresh failure reasons (the `auth.refresh.failed` event's `payload.reason`):

- `invalid_token` — cryptographic failure (bad signature, malformed, wrong issuer)
- `expired_token` — `exp` in the past
- `wrong_kind` — caller sent an access token to the refresh endpoint
- `revoked` — token verified cryptographically but was added to the revocation list by a previous `logout`
- `user_no_longer_exists` — token references a `user_id` that's no longer in the directory

The login endpoint deliberately returns the same `401 unauthorized` on "no such user" and on a future bad-password path — it doesn't disclose whether the email exists. The seed directory in `services/api-gateway/src/auth/directory.ts` carries three roles (`operator`, `supervisor`, `admin`) used across the demo.

## Rate-limit budgets

`@fastify/rate-limit` is registered at the app level on api-gateway with a per-IP token bucket. Two budgets:

| Scope                                      | Max / min | Override site                                          |
| ------------------------------------------ | --------- | ------------------------------------------------------ |
| Global (every `/api/v1/*` route)           | 240       | `GLOBAL_MAX_PER_MINUTE` in `app.ts`                    |
| `POST /api/v1/auth/{login,refresh,logout}` | 20        | `AUTH_MAX_PER_MINUTE` (route-level `config.rateLimit`) |

The auth surface is tighter on purpose — it's the public path most worth brute-forcing. A block on either budget returns `429 Too Many Requests` with a `Retry-After` header and emits a `rate_limit.blocked` security event.

**Store.** In production the bucket is Redis-backed (`@aip/redis-client`, dedicated connection — _not_ shared with the security-events publisher so a connection flap on one doesn't degrade both). In tests + dev without Redis it falls back to an in-process Map.

**`skipOnError: true`.** A Redis hiccup degrades to "no rate limit applied" rather than 500ing every request. Fail-open is the right posture for a user-facing surface; the security-events publisher's swallow covers the audit side.

**Keying.** `req.ip` (Fastify's `trustProxy`-aware accessor). Behind nginx the source IP is the `X-Real-IP` header that nginx sets; api-gateway's `trustProxy` config honours it.

## Refresh-token revocation

The `RefreshTokenRevocationList` interface (`@aip/auth-jwt`) is a two-method contract: `revoke(token)` adds, `isRevoked(token)` checks. Both are idempotent.

- **Demo implementation.** `InMemoryRefreshTokenRevocationList` — per-process `Set<string>`. Lost on restart, not shared across replicas. Fine for the single-instance demo; see [ADR 0013](../adr/0013-refresh-token-revocation.md) for the production Redis-with-TTL implementation that swaps in cleanly.
- **Order of checks.** `POST /api/v1/auth/refresh` verifies the JWT cryptographically _first_, then consults the revocation list. A malformed token surfaces as the usual `invalid_token` / `expired_token` reason — never `revoked`. This avoids leaking which token strings the server has ever seen.
- **Logout idempotency.** Re-revoking an already-revoked token still returns `204` — set semantics make it free, and the frontend's `logoutAndNotifyServer()` retries are safe.

## Security-event vocabulary

`@aip/security-events` defines seven event types. Every emit goes to Redis on `events.security.<event_type>`; audit-service `psubscribe`s to `events.security.*` and writes each one into the hash-chained `audit_events` table.

| Event                    | Emitter     | Actor          | Trigger                                    |
| ------------------------ | ----------- | -------------- | ------------------------------------------ |
| `auth.login.succeeded`   | api-gateway | the user       | Successful `POST /api/v1/auth/login`       |
| `auth.login.failed`      | api-gateway | `null`         | Email lookup returned no user              |
| `auth.refresh.succeeded` | api-gateway | the user       | Successful `POST /api/v1/auth/refresh`     |
| `auth.refresh.failed`    | api-gateway | user or `null` | Refresh rejected (5 reasons; see above)    |
| `auth.logout`            | api-gateway | the user       | Successful `POST /api/v1/auth/logout`      |
| `access.denied`          | api-gateway | user or `null` | Protected route closed with `401` or `403` |
| `rate_limit.blocked`     | api-gateway | user or `null` | Limiter rejected the request               |

Envelope shape (`SecurityEvent` in `packages/security-events/src/index.ts`):

```json
{
  "event_id": "5a9c…-uuid",
  "event_type": "access.denied",
  "schema_version": "v1",
  "source": { "service": "api-gateway" },
  "timestamp": "2026-06-04T12:00:00.000Z",
  "actor_user_id": "user-supervisor-1" | null,
  "subject_id": null,
  "correlation_id": "abc-…-request-id",
  "payload": {
    "route": "/api/v1/incidents/:id/acknowledge",
    "method": "post",
    "status": 403,
    "ip": "10.0.0.5",
    "actual_role": "operator"
  }
}
```

Why `actor_user_id` is sometimes null: a failed login can't identify the user (the email isn't in the directory), and an unauthenticated 401 doesn't have a verified token to read a `user_id` from. A 403 always has an actor (the user verified, the role check rejected).

Today api-gateway is the only emitter. Downstream services (audit-service, incident-service, …) emit their own `access.denied` when their own `requireRole` trips is a deferred follow-up; the envelope already supports it (`source.service` distinguishes).

## Failure surfaces — what the oncall reads

The fast triage path when something is wrong with auth:

1. **Logs.** Every auth-relevant decision logs through `@aip/logger` with `request_id` + `correlation_id` attached (see [logging.md](./logging.md)). Search for `service: api-gateway` + the route the user reports. Login failures log at info; verify failures inside `verifyJwtHook` are silent by design — look at the security event instead.
2. **Security events.** `audit-service` has the full hash-chained record. The fastest query for "did this user just hit a 403?" is `audit_events WHERE event_type IN ('access.denied', 'rate_limit.blocked') AND actor_user_id = ? ORDER BY ts DESC LIMIT 20`. The `payload.route` + `payload.reason` columns tell you which gate fired.
3. **Metrics.** RED triple on `/metrics` (see [metrics.md](./metrics.md)) covers the gateway shape. Two domain counters from `@aip/security-events` show emission health:
   - `security_events_published_total{event_type=...}` — emission rate per type
   - `security_events_publish_failures_total{event_type=...}` — emission failures (Redis down, etc.)
     A persistent gap between `auth.login.succeeded` rate and `auth.login.failed` rate (e.g. failures spiking) is the brute-force shape.
4. **Rate-limit headers.** A `429` response carries `Retry-After` + `X-RateLimit-Remaining`. A client that's getting throttled but not malicious usually means a misconfigured retry loop on its side; cross-check against `rate_limit.blocked` events filtered by IP.

### Common failure modes

- **Every refresh suddenly returns `401 unauthorized` with `reason: invalid_token`.** Check whether `JWT_SECRET` rotated without redeploying the api-gateway. The secret-mismatch path surfaces as `invalid_token` (signature verify fails), not `expired_token`.
- **One user can't log in but others can.** Check `auth.login.failed` events for `payload.reason: no_such_user` — the email isn't in the seeded directory. Production with a real Postgres-backed directory would also show DB-lookup errors here.
- **Every request is `429`.** Check whether `nameSpace: "aip-rl:"` keys are shared across api-gateway replicas (intended) or — worse — keys collided with another consumer of the same Redis. Cardinality of the `rate_limit.blocked` payload's `ip` column tells you whether it's per-IP or a collapsed bucket.
- **Logout "works" but the user is back in after 5 seconds.** Either (a) two api-gateway replicas and only one revocation list saw the token — symptom of the in-memory implementation, fixed by the Redis-backed one; or (b) the frontend never cleared `localStorage` and is reusing the old access token until it expires (15 min). Check whether `useAuthStore.logout()` actually ran.
- **A new service can't authenticate the bearer it receives.** It needs the same `JWT_SECRET` env var and the same `verifyJwtHook` registration order as the existing services — `correlationHook` first, `verifyJwtHook` second, route preHandlers third. Order matters: `requireRole` must run after `verifyJwtHook` to see `req.auth`.

## Test seam

Every auth concern has a test-injectable surface:

- `buildApp({ signer })` — pass a `createJwtSigner({ ..., now: () => fixed })` to make tokens deterministic
- `buildApp({ rateLimitDisabled: true })` — skip the limiter for tests that fire hundreds of injects
- `buildApp({ securityEvents: new RecordingSecurityEventPublisher() })` — default in tests; lets `expect(events.published).toContainEqual(...)` work without Redis
- `buildApp({ directory })` — synthetic user lookup so tests don't depend on the seeded data
- `buildApp({ revocationList })` — assert on revoke/check calls in tests
- `buildApp({ upstreams: { audit: "", incident: "" } })` — empty strings skip the proxy registration entirely

The shape mirrors the test seams in [logging.md](./logging.md) and [metrics.md](./metrics.md): every production wiring concern is a constructor option, every default is the production-correct one, and every override exists to let a unit test be deterministic without staging an external dependency.

## Production evolution

The current posture targets the demo. Real production should:

- **Move HS256 → RS256 (or EdDSA) + JWKS.** Multiple services issuing tokens means the symmetric secret has to be shared everywhere; asymmetric + a JWKS endpoint at `api-gateway` lets each downstream verify with the public half. `createJwtSigner` is the only call site that changes; `verifyJwtHook` keeps its shape.
- **Swap the in-memory revocation list for Redis-backed.** `TTL = exp - now` on each revoke so the set self-prunes. Same interface, drop-in.
- **Add `access.denied` emission in downstream services.** The envelope already supports it (`source.service`). Wire it into each service's `onResponse` hook, identical to the api-gateway shape.
- **Promote `correlation_id` to a distributed trace id.** OpenTelemetry W3C `traceparent` propagation across services; the audit chain's `correlation_id` column joins to the span trace.
- **Move tokens out of `localStorage`.** httpOnly + SameSite cookies + a session row in Postgres. The store mechanics change but the role-on-the-access-token model can stay, with the cookie carrying the JWT and a session-revocation lookup on the way back in.
- **Per-tenant + per-endpoint rate-limit tiers.** Today every `/api/v1/*` shares one budget; production wants tighter on writes than reads and tiered by plan / role. Same `config.rateLimit` hook, just more buckets.

None of these change the surface a route file sees — they change wiring at boot.
