# ADR 0013: refresh-token revocation via an out-of-band list

- **Status**: Accepted
- **Date**: 2026-06-04
- **Owner**: Security Engineer
- **Reviewers**: Platform Architect, Backend, Frontend, SRE

## Context

Phase 5 landed the JWT auth surface — `POST /api/v1/auth/login` mints an access + refresh pair, `POST /api/v1/auth/refresh` swaps a refresh token for a new access token. Both tokens are signed JWTs. The access TTL is short (minutes); the refresh TTL is long (days) so the user doesn't have to re-enter credentials on every reload.

That left two related problems open going into Phase 6:

1. **No way to end a session.** A signed JWT is valid until its `exp`. There is no cryptographic operation we can perform on an already-issued token to invalidate it. The frontend `useAuthStore` could clear `localStorage` on logout, but a copy of the refresh token harvested before logout (XSS read, shoulder-surfed device, stolen laptop) keeps working until the server-side `exp` lapses. For the demo posture this is the single largest "production-different" gap in the auth story, and ADR 0011 explicitly flagged it as deferred.
2. **The audit chain has no `auth.logout` event.** T-506 wired emission for `auth.login.*` and `auth.refresh.*`, but there was no logout endpoint to hang the corresponding event off. The audit timeline could show a user logging in and then silently going dark — no way to distinguish "session ended" from "session lapsed naturally" from "browser was closed."

Both problems point at the same missing piece: a server-side gate that says "stop honouring this specific token, even though it still cryptographically verifies." That is the canonical role of a revocation list.

## Decision

**Introduce a `RefreshTokenRevocationList` interface in `@aip/auth-jwt` and a server-side `POST /api/v1/auth/logout` endpoint that consults it.** The endpoint validates the supplied refresh token, adds its string form to the list, and emits an `auth.logout` security event. The existing `POST /api/v1/auth/refresh` endpoint checks the list after cryptographic verification and before issuing a new access token; a hit returns `401` with `reason: revoked`.

Concretely:

- `RefreshTokenRevocationList` is two methods: `revoke(token): Promise<void>` and `isRevoked(token): Promise<boolean>`. Both are idempotent. The interface is intentionally narrow so the Redis-backed production implementation is a drop-in.
- The default implementation is `InMemoryRefreshTokenRevocationList` — a per-process `Set<string>`. Lost on restart, not shared across replicas, perfect for the single-instance demo. Production wires a Redis-backed one (see below).
- **Key is the raw token string.** Not the `jti` claim (the JWTs minted here don't set one yet) and not the `user_id` (a logout should end _this_ session, not every session the user has open). Storing the raw string isn't worse than storing it in `localStorage` — if the JWT secret leaks the whole scheme is already broken.
- **The revocation check runs after `signer.verifyRefresh(...)` succeeds, not before.** A malformed or expired token surfaces as the normal `AuthJwtError` path (`invalid_token`, `token_expired`) rather than as `revoked`. This avoids leaking information about which token strings the server has ever seen.
- `POST /api/v1/auth/logout` verifies the refresh token, revokes it, emits the `auth.logout` event, and returns `204`. A malformed token returns `401` without emitting — we don't know whose session it was, and a `null` actor would muddy the audit chain.
- The frontend `useAuthStore.logoutAndNotifyServer()` calls the endpoint fire-and-forget, then clears local state regardless of the response. A server hiccup must never block the user from signing out locally.

The contract lives in `@aip/auth-jwt` because revocation is part of the JWT verification story, not part of api-gateway's transport layer; a future worker that needs to validate refresh tokens (admin tooling, background session cleanup) pulls the same interface.

## Alternatives considered

- **JWT denylist keyed by `jti`.** Rejected for now because our signer doesn't yet stamp `jti` on refresh tokens — adding one would mean a contract change across the auth surface to get a more compact key (UUID vs full token string) that the demo doesn't benefit from. The interface keeps the key as `string`, so swapping to `jti` later is a signer change plus a one-line callsite change, not a re-design.
- **Opaque session tokens instead of JWTs.** Rejected because it would re-litigate ADR 0011's posture (JWT + HS256). Opaque tokens force every protected route through a session-lookup round-trip — the entire reason we picked self-verifying JWTs was to avoid that for read traffic. Revocation is the narrow problem; rewriting the whole auth model to solve it is the wrong shape.
- **Short-lived access tokens only, no refresh.** Rejected because the access TTL is measured in minutes for a reason — re-logging-in every time it lapses is hostile to the demo's intended ops flow (reviewer leaves the dashboard open across a shift). The refresh token is the right primitive; what it needs is a way to be ended.
- **Session cookies + server-side session table.** Rejected for the demo as the largest of the four options — a full rewrite of the auth posture, including a database table, session middleware, CSRF protection, and a migration path for the existing frontend store. ADR 0011 already documents this as the production-evolution target; doing it now in service of logout is overreach.

## Trade-offs

- **Lost**: cross-replica revocation. The in-memory `Set` lives in one api-gateway process. Two replicas means a logout against replica A is invisible to a refresh against replica B until restart. For the demo (single replica) this is a non-issue; the Redis-backed implementation closes it without any callsite changes.
- **Lost**: unbounded set growth. Without TTL, the in-memory set grows for the lifetime of the process. A long-running demo with a chatty test suite eventually allocates non-trivial memory. The fix is the Redis-backed implementation with `TTL = exp - now`; the in-memory version is bounded only by the process lifetime, which is short enough to not matter here.
- **Lost**: revocation by `user_id`. We can't end every active session for a user in one call — that would be a different method (`revokeAllForUser(user_id)`) and a different key shape. Out of scope; the explicit user-facing action is "log out of this device."
- **Kept**: a single audit point for session close. `auth.logout` joins the existing `auth.login.*` + `auth.refresh.*` chain, so the audit timeline reads as a complete session arc.
- **Kept**: the refresh endpoint's existing error envelope. `revoked` is a sub-`reason` of `auth.refresh.failed`, not a new event type — the audit consumer doesn't change.
- **Kept**: idempotency. Both `revoke` and `isRevoked` are set-shaped operations; the network can retry the logout call without side-effect.

## Consequences

- **`/api/v1/auth/refresh` has a third 401 path.** Was: `invalid_token`, `token_expired`, `user_no_longer_exists`. Now also `revoked`. The frontend's lazy-401-retry path in the API clients treats all four the same (clear state, redirect to login) so no client-side branching is needed; only the audit consumer distinguishes them.
- **Logout is now a network call.** The frontend `useAuthStore.logoutAndNotifyServer()` posts to the gateway before clearing local state. It is wrapped in `try { ... } catch {}` so a network failure still ends the local session — the user must never get stuck signed in. The consequence is that _server-side_ revocation is best-effort from the user's perspective; if the network drops, the refresh token stays valid until `exp`. Acceptable for the demo.
- **Audit chain shape changes.** A complete session now looks like `auth.login.succeeded` → ... → `auth.logout` instead of `auth.login.succeeded` → (silence). Downstream consumers (the `/audit/security` filtered list endpoint planned for the reviewer UI) can render session length and explicit-vs-implicit close.
- **Tests need an injected revocation list.** `buildApp({ revocationList })` accepts one for tests; the default is the in-memory implementation. Test for "refresh after logout returns 401" lives in the api-gateway test suite and asserts on both the status code and the `auth.refresh.failed` event with `reason: revoked`.

## Production evolution path

- **Redis-backed list with TTL.** The natural production implementation: `SET aip-rt-revoked:<token> 1 EX <exp - now>` on revoke, `EXISTS` on check. The TTL means the set self-prunes — no background sweeper, no growth past the longest-lived refresh TTL. Same `RefreshTokenRevocationList` interface; the api-gateway `main.ts` swaps in `new RedisRefreshTokenRevocationList(redisClient)` and nothing else changes. Should use a dedicated Redis client (separate from rate-limit + security-events) so a connection flap is scoped, mirroring the pattern in [ADR 0012](0012-api-gateway-as-public-surface.md) for the rate-limit Redis client.
- **`jti`-based keys.** When the signer learns to stamp `jti` (a random UUID per minted refresh token), swap the key in the Redis-backed implementation from the full token to the `jti` claim. Shorter keys, no token-string material at rest in Redis. The interface stays `string`-keyed; only the call sites in `routes/auth.ts` change from `parsed.data.refresh_token` to `verified.jti`.
- **`revokeAllForUser(user_id)`.** Adds an admin-tooling shape: terminate every active session for a user (compromised account, role change, employment ends). Implemented as a secondary index in Redis (`SADD aip-rt-by-user:<user_id> <jti>`) that the revoke call writes alongside the per-token key. Becomes relevant once we have an admin UI; out of scope for the demo.
- **Migration to session-cookie auth.** When the deployment story moves past the portfolio demo, the whole revocation primitive becomes structurally simpler: a session row in Postgres can be `UPDATE ... SET revoked_at = now()` and every subsequent request sees it on the read side. The revocation list becomes a single-table query, not a separate cache. ADR 0011's production-evolution path already names this as the target posture; this ADR is the bridge that keeps the demo coherent until then.
- **Refresh-token rotation.** Orthogonal but related: each successful `/auth/refresh` could rotate the refresh token (issue a new one, revoke the old one in the same flow) so a stolen refresh token has a one-shot lifetime. Same primitive, used proactively rather than reactively. Belongs to a follow-up ticket once the Redis-backed list is in place.
