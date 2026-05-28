# Changelog

All notable changes land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-27

**Phase 1 — Product Skeleton.** The platform's rails: monorepo, Compose stack, infra packages, shared contracts, schema, ten service shells, frontend shell, NGINX entry point, seed data, and CI.

### Added

#### Infrastructure & tooling

- **pnpm + Turbo monorepo** with strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), ESLint 9 flat config, Prettier 3, EditorConfig (#84).
- **Docker Compose base stack** — Postgres 16, Redis 7, NGINX with real readiness healthchecks and named volumes (#85).
- **PolyForm Noncommercial 1.0.0** license + NOTICE + TERMS_OF_USE (#87).
- **CI workflow** — lint + typecheck + unit tests on every PR (#89), expanded with a **Python ai-inference** job in #101.

#### Shared packages

- `@aip/shared-contracts` — Zod schemas + inferred types for enums (Severity, IncidentStatus, SensorType, Role, DetectionClass), domain entities (Airport, Runway, Sensor, User), event envelope, API DTOs, WS messages, error codes (#86).
- `@aip/logger` — pino-based structured logger with AsyncLocalStorage request/correlation propagation and safe-by-default redaction (#90).
- `@aip/metrics` — prom-client wrapper with RED and queue factories (#91).
- `@aip/postgres-client` — pg pool + `withTransaction` + health probe (#92).
- `@aip/redis-client` — ioredis + exponential-backoff reconnect + channel naming convention + health probe (#93).
- `@aip/http-client` — native fetch + timeouts + retries + standalone CircuitBreaker (#94).
- `@aip/db-schema` — Drizzle schemas, 0001 initial migration with audit-grant revocation (ADR 0010), programmatic `runMigrations()` + hash-tracked ledger, `pnpm db:migrate` CLI (#95). Added `seedFromJson()` + `pnpm db:seed` in #104.

#### Services (10 shells)

| Service                | Port | Highlights                                                                                            |
| ---------------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `reference-data`       | 3002 | Source-of-truth REST (airports, runways, sensors, SOP baseline) (#96)                                 |
| `api-gateway`          | 3001 | Fastify shell with request-id propagation, auth-decode stub, canonical error envelope, /metrics (#97) |
| `sensor-gateway`       | 3003 | Fastify + Redis (#98)                                                                                 |
| `event-pipeline`       | 3004 | Fastify + Redis + Postgres (#98)                                                                      |
| `ws-broadcaster`       | 3005 | Fastify + `@fastify/websocket` + placeholder /ws/v1/ping echo (#98)                                   |
| `incident-service`     | 3006 | Fastify + Postgres (#99)                                                                              |
| `audit-service`        | 3007 | Fastify + Redis + Postgres; audit table append-only at DB role level (#99)                            |
| `notification-service` | 3008 | Fastify + Redis; stub channel registry (#99)                                                          |
| `validation-engine`    | 3009 | Orchestrator + 10 layer stubs, `POST /validate` returns ordered run (#100)                            |
| `ai-inference`         | 8000 | Python 3.12 FastAPI + async Redis + Prometheus (#101)                                                 |

#### Frontend

- `apps/web` — Nuxt 3 SSR shell, dark-mode design tokens (`aip.*`, `severity.*`, `conn.*`), Pinia `system` store, operator layout with sticky header, role badge, connection status pill, six-question framework on the home page, branded 404/500 (#102).

#### Reverse proxy

- `infrastructure/docker/nginx` — single ingress on host 3000; routes `/health` (nginx), `/api/*` (api-gateway), `/ws/*` (ws-broadcaster with upgrade headers), `/...` (Nuxt). Docker-DNS resolver, baseline security headers, 1h WS timeouts (#103).

#### Documentation

- ADRs 0001 (Redis pub/sub vs Kafka), 0002 (WebSockets vs SSE/long-poll/gRPC), 0003 (10-service boundary rationale) (#88).
- ADR 0010 (audit immutability) promoted from draft to Accepted (#95).
- `docs/architecture/data-model.md` — Mermaid ER diagram + column-level rationale (#95).
- Per-service READMEs.
- `data/scenarios/README.md` — 6 demo scenarios mapped to the tickets that land each end-to-end (#104).

#### Data

- `data/seed/{airports,runways,sensors,users}.json` — 2 airports (KSFO + KJFK), 4 runways, 11 sensors, 3 users (#104).
- `data/seed/reference/{sop-baseline,asset-inventory,approved-documents}.json` — Layer 4 source-of-truth inputs (#104).
- `data/scenarios/0{1,2,3,4,5,6}-*.json` — six demo scenario contracts (#104).

### Tests

- **TypeScript suite**: 230+ unit + integration tests across `packages/` and `services/`. All green on every PR via CI.
- **Python suite**: 6 smoke tests for the AI service shell.
- Vitest projects per workspace; pytest for ai-inference; centralized `__TEST__/` directory per the brief.

### Known deferrals (documented in their respective PRs)

- **Branch protection** — requires GitHub Pro on private repos (free private plan only allows it on public repos). Process is enforced by Git Flow discipline + CONTRIBUTING.md + CI gates instead.
- **Frontend component unit tests** — pnpm strict-isolation prevents `@vue/test-utils` from resolving in the centralized `__TEST__/frontend/` directory. Coverage lands with Playwright e2e in **T-214**.
- **Reference-data entity integration tests** — Drizzle internal driver behavior is brittle to mock at unit tier; real coverage with seeded Postgres lands with **T-208** / **T-214**.

### Verified

- `pnpm install` succeeds on a fresh clone (Node 20 + pnpm 9.12).
- `pnpm typecheck` — 17/17 workspaces pass (Nuxt typecheck included).
- `pnpm lint` — 17/17.
- `pnpm format:check` — clean.
- `pnpm test:unit` — all suites green.
- `docker compose config` parses; `docker compose up` brings all 11 services to healthy on a recent Docker Desktop.

[0.1.0]: https://github.com/joseph-caughey-labs/airport-inspection-platform/releases/tag/v0.1.0
