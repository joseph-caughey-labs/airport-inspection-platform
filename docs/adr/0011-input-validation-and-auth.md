# ADR 0011: Input validation, JWT auth, and RBAC

- **Status**: Accepted
- **Date**: 2026-05-30
- **Owner**: Security Engineer
- **Reviewers**: Backend, Frontend, Principal Architect

## Context

Every public surface of the platform faces three classes of risk that need a unified answer rather than per-route handrolling:

1. **Unvalidated input** — a malformed envelope reaches business logic, crashes the service, or silently does the wrong thing.
2. **Unauthenticated access** — a caller without credentials reads or mutates state they shouldn't.
3. **Authenticated but unauthorized access** — a caller with one role acts as another (operator archiving an incident, etc.).

Earlier phases stubbed all three: `authDecode` parsed a `<user_id>.<role>` placeholder string with zero verification; routes accepted unvalidated bodies; no per-route role gate existed. T-504 closes the auth gap; the rate-limiting + body-size gap closes in T-505 (this ADR documents both decisions together because they share the same enforcement seam).

## Decision

### Input validation — zod at the boundary

- **Every request body parses through a zod schema before any side-effectful logic runs.** Route handlers that need a body declare `Body = z.object({...})` at the top of the file; the route does `Body.safeParse(req.body)` and returns 400 `validation_failed` on failure (with the `details.issues` array from zod).
- **The route handler signature reads typed data.** Inside the handler, `req.body` is the un-typed JSON; the parsed object is what gets used. This makes the boundary explicit and grep-able.
- **No alternative validators are allowed.** Joi / Yup / ajv would introduce three runtime contracts that aren't kept in sync. zod is already the shared-contracts choice.

### Authentication — JWT (HS256 in dev, asymmetric in production)

- **`POST /api/v1/auth/login` issues a pair**: an `access_token` (default 15min TTL) and a `refresh_token` (default 7 days). The access token carries `{ user_id, role, kind: "access" }`; the refresh token carries `{ user_id, kind: "refresh" }`.
- **`POST /api/v1/auth/refresh` swaps a refresh token for a fresh access token.** The refresh token itself stays valid until its own `exp` — refresh-token rotation (issuing a new refresh + invalidating the previous) is the production hardening path (deferred to T-505 alongside the audit hooks T-506 captures).
- **Two-token split has two purposes**: (1) bound the blast radius of a leaked access token via short TTL; (2) allow server-side refresh-token revocation without invalidating every access token already in flight.
- **HS256 is the dev signing algorithm**, symmetric, fastest to verify in-process. **Production deployments with multiple authenticating services move to asymmetric (RS256 / EdDSA) + a JWKS endpoint** so the signing key doesn't have to be shared. The interface (`createJwtSigner`) doesn't change.
- **Verification (`verifyJwtHook`) is an app-level `onRequest` hook** that stamps `req.auth = { user_id, role }` when a valid Bearer token is present. **It does NOT reject on missing or invalid tokens** — the per-route `requireAuth` / `requireRole` helpers decide whether to 401/403. This keeps public endpoints (login, refresh, health, metrics) trivially exempt.

### Authorization — RBAC matrix in `@aip/shared-contracts/auth`

- **Roles**: `operator` (on-shift staff, drives the incident happy path), `reviewer` (HITL queue owner, can resolve/reject/archive + override), `admin` (full access; manages users, runs migrations).
- **Permissions** are named `verb_resource` tuples (`incident.acknowledge`, `audit.verify`, `validation.override`, `platform.admin`, …). Adding a new permission is a one-file edit in `packages/shared-contracts/src/auth/policy.ts`.
- **`PERMISSION_POLICY: Record<Permission, Role[]>`** is the source of truth. `admin` is implicitly allowed everything by `isAllowed()`; the map encodes the non-admin distinctions.
- **`requireRole(...roles)` is the Fastify enforcement helper.** A route uses it as `preHandler: requireRole(...rolesFor("incident.acknowledge"))` — the route file never hand-spells the role list.
- **Frontend reads the same matrix.** `isAllowed(role, permission)` is the same function in both the operator UI's render guards and the backend's route guards — one source of truth for visibility.

### Rate limiting + input safety (T-505 — placeholder here)

- **Token-bucket rate limits per IP + per auth subject** land on `/auth/login`, write endpoints, and WS `connect` (the surfaces that get scanned + brute-forced).
- **Max request body size** enforced at Fastify level.
- **Strict content-type checks** — only `application/json` is accepted on JSON routes.
- **Sanitized error responses** — no stack traces, no internal paths leak into the response body.

## Alternatives considered

- **Session cookies + CSRF tokens** instead of JWT. Rejected — would require server-side session storage (Redis), tying the auth surface to Redis availability. JWT is stateless on the access path; the refresh-token revocation path can use Redis but isn't required.
- **OAuth 2.0 / OIDC delegation to an external IdP.** Rejected for the demo — adds a configuration surface that's out of scope for a portfolio piece. The production evolution path is to swap `createJwtSigner` for a verifier that accepts tokens minted by the IdP.
- **Per-route hand-rolled role checks.** Rejected — same drift problem as retries. `requireRole(...rolesFor(p))` lets the matrix be the source of truth.
- **A single `admin` role with claims-based scopes.** Rejected — operators want a stable mental model ("operator", "reviewer", "admin") for who can do what. Scopes work for service-to-service auth at scale; they're not the right primitive for human roles in this demo.
- **`req.auth` stamping at every route via a decorator.** Rejected — duplicates the work `verifyJwtHook` already does. The app-level hook + per-route `requireAuth` is the cleanest two-step.

## Trade-offs

- **Lost**: per-route discretion on how to handle missing/invalid auth — `requireRole` always returns the standard envelope. A route that wanted, say, a "degraded read-only mode for unauthenticated callers" would have to skip `requireRole` and inspect `req.auth` itself, which is fine but explicit.
- **Lost**: refresh-token rotation. The MVP refresh just issues a new access token without burning the refresh. The rotation hardening lands in T-505/T-506.
- **Kept**: stateless access-token verification; one source of truth for role policy; explicit "no auth" decisions at every public route (login + refresh + health + metrics); per-route 401-vs-403 distinction (401 = no auth, 403 = wrong role).

## Consequences

- New routes that need auth use `preHandler: requireAuth()` (any authenticated caller) or `preHandler: requireRole(...rolesFor(p))` (specific roles). Misuse of `req.auth!` without a preHandler shows up immediately because `req.auth` is `undefined` on a no-auth request and `!`-assertion crashes the request.
- The cross-service rollout (incident-service, audit-service, notification-service, etc. each adopting `verifyJwtHook` + per-route `requireRole`) is a focused follow-up per service. The api-gateway is the canary in this PR.
- The WS channel auth (verifying the JWT on the upgrade request) is its own ticket because the existing `routeWebSocket` Playwright fixture doesn't cover the upgrade dance and that's the right place to add it.
- The frontend integration (storing the access + refresh tokens, attaching `Authorization` on every fetch, hiding role-disallowed UI) is its own ticket — touches every API call in `apps/web/utils/`.
- Audit hooks for login / logout / role change / 401-403 trips land in T-506; the audit-service write path is already in place (T-412).

## Production evolution path

- **Asymmetric signing + JWKS.** A central auth service mints tokens with a private key; downstream services verify with the public key fetched from `/.well-known/jwks.json`. `createJwtSigner` interface doesn't change; the internal implementation swaps the secret for a key pair.
- **Refresh-token rotation**: every refresh call issues a NEW refresh token and invalidates the old one server-side (Redis SETEX on the previous `jti`). A reused refresh token signals theft and revokes the entire family.
- **mTLS for service-to-service.** Internal calls (validation-engine → reference-data, audit-service → notification-service) move to mutual TLS, keeping JWT for human-driven calls only.
- **Replace seeded users with a real directory.** The `UserDirectory` interface is shaped so a Postgres-backed implementation + a hashed-password column drop in without touching the routes.
- **Two-factor auth** on the login route — TOTP / WebAuthn. The login response stays `{ access_token, refresh_token, user }`; the request body grows a `mfa_code` field.
- **Audit every auth event.** Login success, login failure, refresh, refresh-token reuse, 401/403 trips — all flow through audit-service (T-412 + T-506). The hash-chained log makes "who logged in when" a query rather than a forensic dig through log files.
