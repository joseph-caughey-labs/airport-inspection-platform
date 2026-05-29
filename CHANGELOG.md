# Changelog

All notable changes land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-05-29

**Phase 3 — AI inference + detection-aware operator dashboard.** The Python AI service now consumes sensor frames, runs five simulated detector heads, calibrates the output, suppresses false positives across a sliding window, and emits detection events that flow end-to-end to the operator dashboard. The dashboard surfaces them in the alert feed with severity + confidence + a "LOW CONF" indicator when the weather modifier degrades the score.

### Added

#### AI service runtime (`services/ai-inference`)

- **Service runtime** — `FrameConsumer` (Redis pubsub for `sensor.frame.captured`) → `DetectorOrchestrator` → `DetectionPublisher` → `ai.detection.<class>.emitted`. Pydantic models mirror the TS `shared-contracts` envelope so the wire format is contract-checked on both sides. Deterministic given a fixed `RuntimeConfig.seed`. (#119)
- **Detector grid** — five fixture-truth-driven heads with seeded confidence + bbox jitter:
  - **FOD** (#120) — location-aware severity (runway → critical, taxiway → high, apron → medium).
  - **Crack** (#121) — three subtypes (longitudinal, transverse, alligator) with width-driven severity bands per the Domain Expert SOP.
  - **Snowbank** (#122) — height + setback violations vs. `sop-baseline.json`; compliant snowbanks emit nothing.
  - **Wildlife + Anomaly** (#123) — wildlife rates severity by species risk × proximity to the runway buffer; anomaly is a low-confidence HITL routing flag.
- **Confidence calibration + weather degradation** (#124) — per-detector linear calibration (`slope`, `intercept`, `min_publish_threshold`), then a weather modifier driven by `frame.metadata.weather.visibility_m`. Calibration curve + per-detector coefficients documented in `docs/validation/risk-scoring.md`. Calibration NEVER raises confidence; below `min_publish_threshold` drops out before the publisher.
- **Batch inference scheduler** (#125) — opt-in `BatchScheduler` between the consumer and orchestrator. Flushes on `batch_size` (default 8) OR `batch_timeout_ms` (default 200). Single-frame timeouts still flush as a size-1 batch so a lone frame never starves. Every detection in a batch records `metadata.batch.id`.
- **GPU-unavailable fallback simulation** (#126) — `RuntimeModeController` with `gpu` (5 ms) and `cpu_fallback` (50 ms) profiles. Mid-batch toggle via `POST /admin/gpu-state` cleanly affects subsequent emissions. Every detection records `metadata.mode` + `mode_latency_ms` for the audit trail.
- **Temporal smoothing — multi-frame consensus FP suppression** (#127) — `TemporalSmoother` with a sliding window per `(sensor_id, detection_class)`. Default `window_size=5`, `threshold=3`, `classes_to_smooth=("fod",)`: single-frame FOD flickers suppressed, sustained 3+ frames emit with a `metadata.smoothing` audit block. Non-smoothed classes pass through unchanged.

#### Backend integration (`services/event-pipeline`)

- **`AiDetectionBridge`** (#128) — `psubscribe`s to `ai.detection.*.emitted` on its own dedicated subscriber connection and inserts each event into `event_outbox` with `channel=events.broadcast.<airport_id>`. The existing `OutboxWorker` publishes to Redis from there, where `ws-broadcaster` fans it out to the operator dashboard. `payload.airport_id` overrides the configured default — sensor → airport mapping becomes a real reference-data lookup later.

#### Frontend (`apps/web`)

- **AI detection envelope decode** (#128) — `AiDetectionMessage` (regex-shaped `type` so adding a class doesn't force a rebuild), new `DecodeResult.detection` variant, `alertFromDetection` formats the title as `<CLASS> detected · <%>` and routes severity straight from the detector's `severity_hint`. `isLowConfidence(msg, threshold=0.5)` is the indicator hook.
- **"LOW CONF" indicator** (#129) — `AlertItem.low_confidence` is stamped by `alertFromDetection` when the calibrated confidence falls below 0.5. `AlertRow.vue` renders a bordered "LOW CONF" badge with `aria-label="Low confidence detection"` next to the title. Per-alert scope (not feed-wide). Drives scenario 06.

#### Quality + observability

- **Playwright scenario 06 — weather-degraded visibility** (#129) — proves the calibration → frontend chain end-to-end: clear-weather detection shows no badge, weather-degraded detection surfaces the indicator while still appearing in the feed (we surface, not suppress).
- **Risk-scoring documentation** (#124) — `docs/validation/risk-scoring.md` covers the calibration curve, methodology, per-detector coefficient table, weather modifier table, and invariants.

### Test counts

- `@aip/event-pipeline`: **96 tests** (+10 for the AI detection bridge)
- `@aip/ws-broadcaster`: 40 tests
- `@aip/web` (unit): **80 tests** (+18 for detection decoding + low-conf flag)
- `@aip/db-schema`: 29 tests
- `ai-inference` (pytest): **207 tests** across models, orchestrator, publisher, runtime, batch, fallback, smoothing, calibration, and each detector
- Playwright e2e: **8 scenarios** (smoke ×2, fixture-driven feed ×3, weather-degraded ×3)

### Carried into Phase 4 backlog

- Bounding-box overlay on the live map (data flows through; component lands with the incident timeline UI).
- Real-stack integration variants of scenarios 04 + 06 — fold into T-507's dockerized CI workflow.
- Sensor → airport lookup via reference-data instead of `defaultAirportId`.

## [0.2.0] — 2026-05-28

**Phase 2 — Live ingestion + fanout.** Sensor frames flow end-to-end: camera simulator → consumer pipeline → Postgres + outbox → Redis fanout → WebSocket subscribers → live operator dashboard. Reconnect-resume, presence, dedup, and a Playwright e2e harness all included.

### Added

#### Sensor ingestion

- **Camera simulator + simulator runtime** (`services/sensor-gateway`) — produces canonical `sensor.frame.captured` envelopes on Redis with configurable frame rate, geo jitter, and an HTTP control surface for start/stop. 24 unit tests cover envelope shape, scheduling, and shutdown semantics. (#107)

#### Event pipeline (`services/event-pipeline`)

- **Redis consumers + orchestrator + handler model** — `ConsumerOrchestrator` fans envelopes into pluggable handlers with bounded concurrency, dispatch metrics, and a per-handler graceful-stop. Uses ONE labeled metric set (`queue` label) per the prom-client convention (#108).
- **Idempotency-key dedup middleware** — windowed `DedupStore` collapses redeliveries inside the at-least-once Redis fan-out. Configurable `windowMs` (default 5s). (#109)
- **Prioritization + watermark + replay queue** — `WatermarkTracker` discriminates late/in-order/out-of-order; `ReplayQueue` defers late events; outside-in middleware chain: dedup → prioritize → persist. (#110)
- **Persistence + outbox + broadcast publish** — single-TX `INSERT INTO sensor_events` + `INSERT INTO event_outbox`; `OutboxWorker` polls and publishes on `events.broadcast.<airport_id>` at 4 Hz. Includes migration `0002_sensor_events_outbox.sql` (UNIQUE idempotency_key, partial index on unpublished rows). (#111)

#### WebSocket broadcaster (`services/ws-broadcaster`)

- **Per-airport channels + DB hydration + Redis fanout** — pattern-subscribes to `events.broadcast.*`, routes by channel suffix into in-memory `ChannelRegistry`. On-connect hydration replays the freshest N `sensor_events` for the airport so clients paint history before tailing the live feed. `RedisBridge` keeps the pub/sub connection dedicated. (#112)
- **Presence + `last_event_id` reconnect resume** — `presence.snapshot` sent once on connect, `presence.changed` fanned out on every subscribe/unsubscribe. `FrameHydrator.hydrateSince(airportId, cursor)` finds the watermark row via a CTE and returns frames strictly after, with `resume` / `resume_capped` / `resume_fallback` modes. (#113)

#### Frontend (`apps/web`)

- **Live airfield map (MapLibre)** — dark Carto basemap, runway lines colored by status, sensor markers colored by type and ringed by status, fit-to-airfield camera. Exposes a `pulseSensor()` handle for the WS integration. Seed JSON now carries lat/lng for SFO + JFK and start/end coords for each runway. (#114)
- **Live alert feed + sensor health panel** — bounded 1000-item store, severity badges encoded by shape (▲ ◆ ■ ● —) + position + color so colorblind operators discriminate the worst events. Sensor health summary (total / online / stale) sorted by last-seen. Empty / loading / error states wired through `feedState`. (#115)
- **WebSocket integration** — `WsClient` with exponential-backoff reconnect, `last_event_id` resume, `unknown_type` vs `parse_error` decode telemetry. `useAirportLiveStream` orchestrator maps `WsConnectionState` into the global system store and dispatches into the alert + presence stores. Map markers pulse on each `sensor.frame.captured`. (#116)

#### Quality

- **Playwright e2e** (`__TEST__/e2e/`) — fixture-driven scenario 04 (sensor outage) exercises the live ops board through Chromium against the real Nuxt dev server. Smoke tests cover index + airport-page landmark rendering. WS interception via `routeWebSocket` keeps the suite deterministic and dockerless. (#117)
- **CI e2e workflow** runs in a separate job from unit tests so Playwright's cold-start cost doesn't slow the fast-path PR check. Uploads traces on failure.

### Changed

- **Seed JSON** — `data/seed/airports.json` gains `lat`, `lng`, `default_zoom`; `data/seed/runways.json` gains start/end coords. DB schema unchanged; geo lives only in seed JSON until reference-data lands in Phase 3.
- **`apps/web/composables/useSeedData.ts`** — fetch runs with `{ server: false }` so it skips SSR (where Nitro's relative-URL `$fetch` resolves to `localhost` without the dev port and 404s).

### Test counts

- `@aip/event-pipeline`: **86 tests** (consumers + dedup + prioritization + persistence + outbox)
- `@aip/ws-broadcaster`: **40 tests** (registry + hydrator + bridge + presence + resume)
- `@aip/db-schema`: **29 tests** (0001 + 0002 migrations + schema shape)
- `@aip/web`: **62 tests** (alerts + map-geo + seed bundle + sensor health + ws-decoder + ws-reconnect + ws-client)
- Playwright e2e: **5 scenarios** (smoke ×2, fixture-driven feed ×3)

### Known limitations carried into Phase 3

- Fault-injection endpoint (T-204), LiDAR + GPS + IMU + weather simulators (T-202, T-203) — deferred to the Phase 1 backlog.
- Real-broadcaster "kill + restore + replay" scenario — covered by the WsClient unit tests today; full integration variant lands in T-507.

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
