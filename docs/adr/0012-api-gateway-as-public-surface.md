# ADR 0012: api-gateway as the single public surface

- **Status**: Accepted
- **Date**: 2026-06-03
- **Owner**: Platform Architect
- **Reviewers**: Backend, Frontend, Security Engineer, SRE

## Context

The platform has nine Node services + a Python AI service. As more services landed in Phases 4–5, the frontend grew direct calls to several of them: incident-service for write paths, audit-service for lineage reads, ws-broadcaster for the live feed. nginx routed each one separately (`/api/` → api-gateway, `/audit/` → audit-service, `/incidents` → incident-service, `/ws/` → ws-broadcaster).

That worked, but it accumulated four real problems:

1. **Auth + rate-limit duplication.** Every service that took public traffic verified the same JWT and ran the same logic. The api-gateway rate-limit budget (T-505) covered only `/api/*` paths; direct `/audit/` + `/incidents` traffic was unbounded.
2. **Multiple error envelopes.** `@aip/http-safety` (T-505) made each service emit the same envelope shape, but every service maintained its own error-handling code, drifting independently.
3. **Path collisions.** `/incidents/:id` is both a dashboard PAGE (rendered by Nuxt) and an API path (handled by incident-service). PR #165 patched it with a regex location in nginx — a workaround signposting the real issue: the public path namespace was shared between Nuxt and a backend service.
4. **Posture leak into the frontend.** `AuditApi` and `IncidentApi` both defaulted `baseUrl = ""` because the frontend used same-origin paths that nginx routed to the correct service. The frontend code reflected the deployment topology — change the topology and every API client needs an update.

By the end of Phase 5 the shape was clear: api-gateway should be the **only** thing public traffic reaches. Everything downstream is a private backend.

## Decision

**api-gateway is the single public REST surface.** It mounts reverse-proxy routes at `/api/v1/<service>/*` for every downstream service the frontend talks to.

Concretely:

- `@fastify/http-proxy` registered at `/api/v1/audit` → `audit-service:3007/audit` and `/api/v1/incidents` → `incident-service:3006/incidents`. The prefix-rewriting means downstream services keep their existing route definitions untouched (`GET /audit/lineage/:id`, `POST /incidents/:id/acknowledge`) — only the public namespace changes.
- Upstream URLs are configurable on `BuildAppOptions`: tests pass empty strings to skip the proxy registration, production reads `AUDIT_SERVICE_URL` / `INCIDENT_SERVICE_URL` from env (compose-friendly defaults).
- Every proxied request runs api-gateway's hooks before forwarding: rate limit (with `skipOnError` + Redis-backed store), correlation header, JWT verify (req.auth stamped), `access.denied` security-event emission on 401/403.
- The downstream services still own their own auth + RBAC checks. api-gateway forwards the Authorization header unchanged; the downstream verifies the JWT a second time and applies `requireRole(...rolesFor(permission))`. **Defense in depth, not redundant work**: the api-gateway round-trip costs one JWT parse, and downstream's role check uses claims that wouldn't otherwise be present.
- nginx loses the direct `/audit/` + `/incidents` location blocks + their upstreams. Only `/api/`, `/ws/`, and `/` (Nuxt catch-all) remain. The `/incidents/:id` page navigation path now belongs unambiguously to Nuxt.
- Frontend `AuditApi` defaults `baseUrl` to `/api/v1/audit`; `IncidentApi` defaults to `/api/v1/incidents`. Per-method paths drop the prefix (`/lineage/:id`, `/:id/acknowledge`). Unit tests assert on the new public URLs.

The audit-service still owns the hash chain INSERT semantics; incident-service still owns the lifecycle state machine. **What moves is the public namespace, not the responsibility.**

## Alternatives considered

- **Keep the direct nginx routes (status quo from PR #165).** Rejected because it would force every subsequent ticket to choose between adding more direct routes (worsening the four problems) or refactoring at use. Picking the consolidation as a one-shot ticket is cheaper.
- **GraphQL gateway.** Rejected because the read/write surfaces are already shaped as REST envelopes shared via `@aip/shared-contracts`. The gain from a single graph would be eaten by re-modelling every contract.
- **Service mesh sidecar (Linkerd / Istio).** Rejected for the demo as overkill — the actual win (centralized auth + rate-limit + metrics) is achievable with a Fastify plugin and one config block per upstream. A mesh becomes relevant when service-to-service traffic dominates, which isn't true here.
- **gRPC for internal calls + REST at the edge.** Rejected because the existing services all speak Fastify-shaped JSON; introducing protobuf would mean rewriting every route signature for one architectural win we don't yet need.

## Trade-offs

- **Lost**: a free hop. Every request to audit-service + incident-service now passes through api-gateway, adding one network hop + one JSON parse + one JWT verify. On the demo this is sub-millisecond; on a production deployment with cross-AZ latency it's a measurable cost that mesh sidecar or service-to-service auth would eliminate.
- **Lost**: independent scaling shape. With direct nginx routes you could scale audit-service horizontally without touching api-gateway. Now api-gateway is on the request path for every audit read, so it has to scale too.
- **Kept**: one error envelope. One auth point. One rate-limit budget. One place to land observability + per-request correlation. One namespace decision (`/api/v1/<service>`) instead of N nginx location blocks.
- **Kept**: existing downstream route definitions. The proxy rewrites prefix; audit-service has zero idea it's behind a gateway.

## Consequences

- **New service additions go through api-gateway by default.** A new service mounting at `/api/v1/<name>` is one `app.register(httpProxy, ...)` call in api-gateway. No nginx config, no frontend baseUrl edit per environment.
- **api-gateway becomes a critical path for read traffic.** It was already on the auth path, but now it's on every read for audit + incidents. Latency budget + saturation thresholds tighten accordingly — see `docs/operations/metrics.md` for the RED triple to watch.
- **Public URLs are stable.** `/api/v1/audit/lineage/:id` doesn't change if audit-service relocates internally. The frontend code stays put.
- **Path collisions in the dashboard page namespace are over.** Nuxt owns `/`, `/login`, `/airports/:id`, `/incidents/:id` unambiguously; api owns `/api/v1/*`. Future page routes that overlap a service domain (e.g. an `/audits` dashboard page) cause zero confusion at nginx.
- **The api-gateway's CircuitBreaker (T-503) now wraps downstream calls.** A degraded audit-service trips its own breaker; api-gateway returns 503 with the canonical envelope rather than hanging.

## Production evolution path

- **Service mesh sidecar.** If service-to-service traffic outgrows the frontend↔gateway pattern, deploy a sidecar (Linkerd is the lightest landing zone) and let mTLS + service identity replace the in-process JWT verify. api-gateway's role narrows back to "policy at the edge."
- **Path-level rate-limit tiers.** Today every `/api/v1/*` shares the same 240/min global budget; the auth surface overrides to 20/min. Production wants per-tenant + per-endpoint tiers, e.g. tighter on writes than reads. Same hook (`config.rateLimit` per route), just more buckets.
- **JWKS instead of HS256.** When more than one service issues tokens, swap symmetric secrets for asymmetric (RS256 / EdDSA) + a JWKS endpoint. api-gateway and every downstream still call the same `verifyJwtHook`; only `createJwtSigner` changes.
- **Edge cache for read paths.** `/api/v1/audit/lineage/:id` is read-heavy on the timeline replay flow. A cache (Varnish or Cloudflare) in front of api-gateway with TTL bounded by the chain's tip-write rate would carry most of that read traffic; api-gateway becomes the cache-miss path.
- **Path-versioning policy.** `/api/v1/...` lets us land `/api/v2/...` alongside without breaking clients. Document the deprecation timeline + dual-mounting in `docs/operations/` before the first v2 path lands.
