# ADR 0003: Service boundary rationale (10 services + 1 frontend)

- **Status**: Accepted
- **Date**: 2026-05-27
- **Owner**: 01 — Principal Architect
- **Reviewers**: 02 — Backend, 14 — Product Manager

## Context

The brief specifies a multi-service architecture. The platform needs sensor ingestion, AI inference, event processing, validation, incident management, real-time fanout, audit logging, notifications, and a reference-data registry.

Forces:

- **Demo realism** — must look like an enterprise platform, not a monolith.
- **Demo simplicity** — must fit in `docker compose up` and be readable end-to-end.
- **Failure isolation** — sensor outage should not break the operator dashboard.
- **Independent evolution** — AI service and validation engine will iterate at different cadences.
- **Interview legibility** — service boundaries should reflect senior judgment, not arbitrary cuts.

## Decision

Split into **10 services + 1 frontend**:

1. **sensor-gateway** — Simulates and ingests telemetry. Redis pub-only.
2. **ai-inference** (Python) — Consumes frames, emits detection events. Redis pub/sub.
3. **event-pipeline** — Enriches, dedupes, prioritizes, orders, persists.
4. **validation-engine** — Runs the 10-layer Parity validation; routes to HITL.
5. **incident-service** — Incident lifecycle CRUD and state machine.
6. **api-gateway** (Fastify) — REST entrypoint, auth, rate limit, proxy.
7. **ws-broadcaster** — WebSocket fanout, per-airport/role channels.
8. **audit-service** — Append-only, hash-chained audit log.
9. **notification-service** — Email / webhook / in-app delivery.
10. **reference-data** — Source-of-truth registry for runways, sensors, SOPs.

Plus **`apps/web`** (Nuxt 3 frontend — operator + reviewer shells).

Shared concerns (logging, metrics, Redis/Postgres/HTTP clients, contracts) live in `packages/`, not services.

## Alternatives considered

- **Modular monolith** — one Node process with internal modules. Easier to develop, but loses failure isolation and doesn't match the brief's multi-service requirement.
- **Fewer services** (merge audit + notification, or merge ws-broadcaster into api-gateway): reduces ops surface but loses failure isolation and independent-iteration benefits.
- **More services** (split event-pipeline into enrich + dedup + prioritize): over-engineered for the demo. Each split adds inter-service coordination cost.

## Trade-offs

- **Lost**: simplicity of single-process development; lower memory footprint.
- **Kept**: failure isolation; independent deploy/iterate per service; demo realism.
- **Added complexity**: cross-service contracts must be formal (lives in `@aip/shared-contracts`); inter-service calls go through `packages/http-client` with retries.

## Consequences

- Every service has its own Dockerfile, healthcheck, structured logger, metrics endpoint.
- Cross-service types must come from `@aip/shared-contracts` (no duplication).
- Service-to-service synchronous calls use `packages/http-client` with retries + circuit breakers.
- Inter-service events use Redis pub/sub + streams (ADR 0001).
- WebSocket fanout is isolated in `ws-broadcaster` (ADR 0002).
- 9 of 10 services are Node/TS; only `ai-inference` is Python — keeps polyglot footprint minimal.

## Production evolution path

- Keep the 10-service split — it scales to a real airport deployment.
- Move from Docker Compose to Kubernetes (or Nomad) for orchestration; each service becomes a Deployment.
- Add a service mesh (Istio, Linkerd) for mTLS, retries, and per-call observability.
- Promote `validation-engine` and `audit-service` to highly-isolated, regulated subsystems with separate deployment lifecycles, change-review boards, and audit log retention policies.
- Move `ai-inference` to **edge nodes** (Jetson-class) per airport for latency; cloud aggregation handles batch model updates, drift monitoring, and centralized validation.
- Split `event-pipeline` if specific stages (dedup, replay) need independent scaling.
