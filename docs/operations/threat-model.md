# Threat model & security test matrix

What the platform defends against, where each defense lives, and the test that pins it. This is the index a reviewer reads to answer "is _that_ covered?" without grepping the suite.

Pairs with [Auth surface — operational guide](./auth.md), [ADR 0011 — Input validation, JWT auth, and RBAC](../adr/0011-input-validation-and-auth.md), [ADR 0012 — api-gateway as the single public surface](../adr/0012-api-gateway-as-public-surface.md), and [ADR 0013 — Refresh-token revocation](../adr/0013-refresh-token-revocation.md). Those carry the _why_; this is the _what we defend_ and the _test that proves it_.

## Trust boundaries

```
 internet
    │  (untrusted)
    ▼
  nginx ──► api-gateway ──► downstream services ──► postgres / redis
            │                │
            │                └── verifyJwtHook + requireRole  (verifies LOCALLY,
            │                     does not trust the upstream hop)
            └── verifyJwtHook + rate-limit + body-limit + sanitized envelope
```

Two facts drive the model:

- **The gateway is the only public surface** (ADR 0012). Audit and incident traffic is proxied through it, so the auth point, the rate-limit budget, and the error envelope are singular.
- **Every downstream service re-verifies the JWT itself.** A leaked or forged token that somehow reaches a service directly is still rejected — services do not trust "the gateway already checked." This is the property the cross-service RBAC matrix exists to pin.

## Threat → defense → test

| #   | Threat                                                 | Defense                                                        | Where                                         | Pinned by                                                                                                                                            |
| --- | ------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Forged / tampered token                                | HS256 signature verify against `JWT_SECRET`                    | `@aip/auth-jwt` `verifyAccess`                | `__TEST__/unit/auth-jwt/jwt.test.ts`, `__TEST__/security/api-gateway/input-safety.test.ts`, `__TEST__/security/incident-service/rbac-matrix.test.ts` |
| T2  | Self-minted privilege escalation (forge `role: admin`) | Signature is the gate, not the role claim                      | gateway + every service                       | `__TEST__/security/api-gateway/input-safety.test.ts` (`self-signed admin … cannot reach`)                                                            |
| T3  | Bearer-header bypass (empty / garbage / wrong scheme)  | `verifyJwtHook` leaves `req.auth` unset → `requireAuth` 401    | `@aip/auth-jwt` fastify hooks                 | `__TEST__/security/api-gateway/input-safety.test.ts` (bypass matrix)                                                                                 |
| T4  | Token-kind confusion (access used as refresh)          | `kind` claim checked before trust                              | `verifyRefresh`                               | `__TEST__/services/api-gateway/auth.test.ts`, `input-safety.test.ts`                                                                                 |
| T5  | Wrong-role access to a privileged action               | Deny-by-default `requireRole(...rolesFor(perm))` per route     | every service route table                     | `__TEST__/security/incident-service/rbac-matrix.test.ts` (operator → 403 on archive/reject)                                                          |
| T6  | Unauthenticated access to protected data               | Deny-by-default 401 on every protected route                   | every service                                 | `rbac-matrix.test.ts` (no-token sweep, all 10 routes)                                                                                                |
| T7  | Stolen refresh token after logout                      | Revocation list checked post-verify                            | `@aip/auth-jwt` `RefreshTokenRevocationList`  | `__TEST__/services/api-gateway/logout.test.ts`                                                                                                       |
| T8  | Brute-force / credential stuffing                      | Token-bucket rate limit (240/min global, 20/min auth)          | api-gateway `@fastify/rate-limit`             | `__TEST__/services/api-gateway/rate-limit.test.ts`                                                                                                   |
| T9  | Resource exhaustion via oversized body                 | 256 KiB body limit → 413                                       | `@aip/http-safety` `DEFAULT_BODY_LIMIT_BYTES` | `__TEST__/services/api-gateway/rate-limit.test.ts`                                                                                                   |
| T10 | SQL-injection / XSS / log4shell-shaped input           | Schema validation + parameterized queries; JSON-only responses | route zod schemas, `@aip/http-safety`         | `__TEST__/security/api-gateway/input-safety.test.ts` (hostile-email matrix)                                                                          |
| T11 | Information disclosure via error responses             | 5xx scrubbed; generic 4xx; no stack / internal path            | `@aip/http-safety` `safeErrorHandler`         | `input-safety.test.ts`, `__TEST__/services/api-gateway/app.test.ts`                                                                                  |
| T12 | User enumeration on login                              | Identical 401 + generic message for unknown vs. bad credential | gateway auth route                            | `__TEST__/services/api-gateway/auth.test.ts`                                                                                                         |
| T13 | Audit-log tampering                                    | Append-only SHA-256 hash chain + `verifyChain`                 | audit-service chain                           | `__TEST__/services/audit-service/hash.test.ts`, `app.test.ts` (`/audit/verify`)                                                                      |

## The T-514 security suite

`__TEST__/security/` consolidates the threat-framed regression tests that the per-service behavioural suites don't cover. It is wired into the existing per-service vitest runners (gateway specs run under api-gateway, RBAC matrix under incident-service), so it gates on every PR through the normal `turbo run test` path — there is no separate security job to forget.

- **`security/api-gateway/input-safety.test.ts`** — Authorization-header bypass matrix, token forgery (incl. the self-minted-admin escalation), token-kind confusion, and a hostile-input matrix (SQLi / XSS / JNDI / path-traversal shaped login payloads) asserting clean 4xx, no 5xx, and no reflection or stack/path leakage.
- **`security/incident-service/rbac-matrix.test.ts`** — incident-service stands in for the policy every service shares: a no-token 401 sweep across all 10 protected routes, the operator/reviewer privilege boundary on the review-only `archive`/`reject` routes (operator → 403; reviewer & admin clear the guard), and a foreign-secret forged token rejected locally (proving services verify rather than trust the hop).

### What is intentionally NOT here

- **CSRF** — the platform is a token-in-`Authorization`-header API, not a cookie-session app, so there is no ambient credential for a cross-site request to ride. No CSRF tokens are needed; documented rather than tested.
- **Password attacks** — the demo's login is an email-to-role directory lookup with no password (see `auth.md` "Demo posture"). Production would add credential verification and the corresponding tests.
- **Transport security (TLS)** — terminated at nginx / the ingress in a real deployment; out of scope for the in-process test surface.

## Oncall: what a security signal looks like

Security-relevant actions land on the same hash-chained audit log as incident transitions (via `@aip/security-events` → audit-service). When triaging:

- A burst of `auth.login.failed` from one IP → credential stuffing; the rate limiter should already be emitting `rate_limit.blocked` alongside it.
- `access.denied` outside the auth surface → a token with the wrong role hitting a guarded route (or a stale frontend not hiding a control). Cross-check the `correlation_id` against the gateway log.
- `auth.refresh.failed` with `reason: revoked` → a logged-out session's refresh token being replayed; expected once after logout, suspicious if repeated.
