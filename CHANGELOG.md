# Changelog

All notable changes land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-06

**Demo-ready — the production-engineering layer is complete.** The working stack landed across Phases 1–6; this release adds what turns a code exercise into a portfolio piece you can put in front of an interview panel: the tests, documentation, and CI gates that prove the system was designed past the happy path. The security and load suites assert (rather than claim) that auth holds and the stack recovers; the failure-mode matrix and runbooks make every failure detectable and operable; the ADR set is complete; and the flagship docs tie every claim to the artifact that backs it. The Phase 5 definition of done — observability, auth/RBAC, full CI + security scan, complete docs, and load + security tests — is met.

### Added

#### Tests — security + resilience (`__TEST__/security`, `__TEST__/load`)

- **Security regression suite** (#174, **T-514**) — `__TEST__/security/`, wired into the existing per-service vitest runners. Gateway input-safety (Authorization-header bypass matrix, token forgery incl. the self-minted-admin escalation, kind confusion, SQLi/XSS/JNDI/path-traversal input safety) and a cross-service RBAC enforcement matrix on incident-service (deny-by-default 401 sweep, the operator/reviewer privilege boundary on review-only routes, foreign-secret forged tokens rejected locally). Plus `docs/operations/threat-model.md` indexing the full threat → defense → test matrix.
- **Load + resilience suite** (#175, **T-513**) — a new `@aip/load-tests` workspace package: seven scenarios driving the live compose stack and asserting SRE thresholds via `/metrics` (high-frequency ingestion, WS fanout, queue-backlog shedding, Redis outage, DB-latency freeze, AI-outage isolation, replay-after-restart). Faults injected at the container boundary; clean skip when the stack is down; isolated from per-PR CI (`pnpm test:load`).

#### CI — security scanning (`.github/workflows/security-scan.yml`)

- **Trivy dependency + image scanning** (#180, **T-508**) — a `dependency-scan` hard gate (`trivy fs` over the pnpm + Python lockfiles, fails on fixable HIGH/CRITICAL) plus an advisory image scan over every built image. The gate immediately caught and this release fixes two real CVEs: **CVE-2026-33805** (`@fastify/http-proxy` → 11.x) and **CVE-2026-39356** (`drizzle-orm` → 0.45.x).

#### Documentation — the demo-readiness set

- **Failure-mode matrix** (#176, **T-509**) — `docs/FAILURE_MODE_MATRIX.md`: all 11 failure modes with detection, recovery, operator UX, metrics, retryability, and manual-intervention, each traced to code, with honest gaps marked as production evolution.
- **Operations runbooks** (#177, **T-510**) — `docs/runbooks/`: decision-tree startup, recovery, replay, escalation, and troubleshooting procedures grounded in real commands.
- **ADRs finalized** (#172, #178, **T-511**) — the remaining drafts written and pinned: 0004 (AI inference simulation), 0006 (event ordering & dedup), 0007 (edge/cloud separation), 0009 (HITL routing thresholds), alongside the earlier 0012/0013. The `docs/adr/` set is complete.
- **Flagship interview docs** (#179, **T-512**) — `README` polished to the real running-stack quickstart + architecture, `README_INTERVIEW.md` (claim → proof), `docs/DEMO_WALKTHROUGH.md` (timed script), and `docs/PR_REVIEW_GUIDE.md` (guided code tour).
- **Demo rescue pack** (#181, **T-515**) — `docs/DEMO_RESCUE.md`: pre-flight checklist, per-beat fallbacks, a total-failure plan, and canned talking points (the "rescue plan documented" criterion).
- **Auth operations guide** (#173) — `docs/operations/auth.md`.

### Fixed

- **`@fastify/http-proxy` 10 → 11.x** (#180) — CVE-2026-33805 (CRITICAL) proxy security bypass; the api-gateway audit/incident proxy routes verified against the dockerized e2e tier.
- **`drizzle-orm` 0.36 → 0.45.x** (#180) — CVE-2026-39356 (HIGH) SQL injection via improperly escaped identifiers; db-schema + reference-data suites green on the bump.

## [0.6.0] — 2026-06-04

**Phase 6 — Real-stack coverage + public-surface consolidation.** The mocked Playwright tier proved frontend behaviour; this phase builds the parallel tier that proves wire behaviour against the live `docker-compose` stack. The same scenarios (sensor outage, weather-degraded LOW CONF, FOD-on-runway full operator workflow) now run twice — fast against `routeWebSocket`, slow against compose — and the slow tier surfaced two real production wiring gaps in incident-service that the fast tier could never have caught. The public REST surface consolidated behind api-gateway proper (no more nginx-direct shortcuts), the rate-limit store moved from in-process to Redis with `skipOnError` graceful degradation, `auth.logout` joined the security-event taxonomy with a refresh-token revocation list backing it, and the incident-detail page finally renders the current envelope alongside the audit-driven timeline.

### Added

#### Dockerized integration tier

- **CI docker layer cache** (#162) — replaces `docker compose build --parallel` with `docker/bake-action@v5` + GitHub Actions cache (`type=gha,mode=max,scope=integration`). First run pays the same cost; subsequent runs reuse the pnpm-install + npm-fetch layers that dominate the build. `actions: write` permission bump because GHA cache needs it to actually warm the cache.
- **Scenario 04 (sensor outage) → integration tier** (#163) — sibling spec to the mocked tier publishes sensor frames to compose Redis on `events.broadcast.<airport_id>`; the real `RedisBridge` fans them to the browser via the WS pipeline through nginx. New `__TEST__/e2e/integration/_helpers/redis-publisher.ts` wraps ioredis with `publishToAirport()` + envelope builders.
- **Scenario 06 (weather-degraded LOW CONF) → integration tier** (#164) — same shape; AI detection envelopes flow through compose Redis to verify the LOW CONF indicator renders against the real calibration path.
- **Scenario 07 (FOD full operator workflow) → integration tier** (#165) — the **capstone**: real `POST /incidents` → real transitions via REST → real audit-service hash-chain INSERTs → `expect.poll` until the audit chain catches up → real timeline page renders the lineage with no `page.route` intercept. nginx grows `/audit/` and `/incidents` proxy locations (path-collision workaround for `/incidents/:id` page navigation).

#### Public surface

- **api-gateway fronts audit-service + incident-service** (#166) — `@fastify/http-proxy` registered at `/api/v1/audit` → `audit-service:3007/audit` and `/api/v1/incidents` → `incident-service:3006/incidents`. Drops the nginx-direct `/audit/` + `/incidents` workaround. **One auth point, one rate-limit budget, one error envelope** — the public surface posture the rest of the platform expected. Frontend `AuditApi` + `IncidentApi` default `baseUrl` updated to `/api/v1/...`.
- **Redis-backed rate-limit store + `skipOnError`** (#167) — `@fastify/rate-limit`'s `redis` option plumbed through `BuildAppOptions`. Production wires a dedicated ioredis instance (separate from the security-events publisher); the count survives both restarts and replica scaling. `skipOnError: true` means a Redis flap degrades to "no rate limit applied" rather than 500-ing every request — safer than fail-closed for the user-facing surface.

#### Security events follow-ups

- **`auth.logout` + refresh-token revocation list** (#168) — closes the T-506 gap the frontend's `useAuthStore.logout()` left open. `POST /api/v1/auth/logout` verifies the refresh token, adds it to a `RefreshTokenRevocationList`, emits an `auth.logout` security event, and returns 204. Idempotent (re-logging-out the same token still 204s). `POST /api/v1/auth/refresh` now consults the revocation list AFTER cryptographic verify; a revoked token returns 401 with `reason: revoked`. Frontend `useAuthStore.logoutAndNotifyServer()` calls the endpoint before clearing localStorage; network failure swallows so local logout always proceeds.

#### Operator dashboard

- **Incident-detail page renders current envelope** (#169) — `IncidentApi.get(id)` issues `GET /api/v1/incidents/:id` (same bearer + 401-retry-once posture as the POST methods via a shared `send` helper). New `useIncidentDetail` composable fetches on mount, refetches on id change, and seeds `useIncidentsStore`. New `IncidentDetailHeader.vue` renders status / severity / assignee / acknowledged-at as a `dl` block next to the title. The detail page (`pages/incidents/[id].vue`) now draws from BOTH services — envelope from incident-service, lineage from audit-service.

### Fixed

- **incident-service `main.ts` never constructed `RedisIncidentEventPublisher`** (PR #165 mid-PR fix) — transitions landed in the DB but never reached the audit chain or notification fanout. Production gap surfaced when scenario-07's capstone test polled the audit chain and never reached 4 rows. `main.ts` now constructs a Redis client + the publisher and passes it to `buildApp`; compose gains `REDIS_HOST` + `depends_on: redis` on incident-service.

## [0.5.0] — 2026-05-31

**Phase 5 — Production-shape hardening.** Every backend service now logs through a single correlated pino instance, exposes the same RED metrics under one prefix, wraps every downstream call in a per-dependency CircuitBreaker, gates every protected route through a shared JWT-verify + per-route `requireRole` keyed off the platform's RBAC matrix, accepts payloads under one body-limit cap and answers 4xx/5xx with one sanitized envelope, throttles via `@fastify/rate-limit`, and emits a security audit event on every login/refresh/access-deny/rate-limit-block that audit-service hash-chains alongside incident transitions. The frontend wires login + token refresh + UI gates against the same policy matrix, the e2e tier gains a sibling job that runs Playwright against the real dockerized stack, and a recurring CI flake gets nailed.

### Added

#### Observability + reliability (`packages/logger`, `packages/metrics`, `packages/http-client`)

- **Centralized correlation hook + per-request log context** (#149, **T-501**) — `correlationHook()` runs on every service's `onRequest`; `enterContext()` uses `AsyncLocalStorage.enterWith` so every downstream log line + every Fastify handler in the same request sees the same `request_id` + `correlation_id`. Bumps `no-console` to `error` workspace-wide so accidental `console.log` calls fail CI. Drops a `docs/operations/logging.md` SRE conventions doc.
- **RED metrics across every Fastify service** (#150, **T-502**) — `installMetrics({ app, registry, prefix?, ignoreRoutes? })` registers a histogram (`*_http_request_duration_seconds`) and a counter (`*_http_requests_total`) labelled `method, route, status` where `route` is the Fastify route pattern (not the URL) and `status` is the family class (`2xx`/`4xx`/`5xx`). Default ignored routes: `/metrics`, `/health`, `/ready`. All 9 Node services wired. SRE notes in `docs/operations/metrics.md`.
- **CircuitBreaker wraps every retry loop in `HttpClient`** (#151, **T-503**, **ADR 0005**) — `breaker.execute(() => requestWithRetries(...))` counts logical failing requests rather than per-attempt; opens after `failureThreshold` consecutive failures, half-opens after `resetTimeoutMs`. 401-vs-403 distinction preserved (auth failures do NOT trip the breaker — they're a client-side credential issue, not an upstream-health one).

#### Auth + RBAC (`packages/auth-jwt`, `packages/shared-contracts/auth`)

- **`@aip/auth-jwt` package + login + refresh + RBAC matrix + api-gateway canary** (#152, **T-504a**, **ADR 0011**) — `createJwtSigner({ secret, issuer })` over `jose` (HS256), with `signAccess` / `signRefresh` / `verifyAccess` / `verifyRefresh`. `AuthJwtError` carries a stable `code` (`invalid_token`, `expired_token`, `wrong_kind`, `invalid_secret`) so error classification doesn't rely on `jose` message strings. Fastify integration: `verifyJwtHook` stamps `req.auth` from the Bearer token; `requireAuth()` and `requireRole(...allowed)` are per-route preHandlers that 401/403 with the shared envelope. `PERMISSION_POLICY` in `@aip/shared-contracts` is the single source of truth both backend and frontend read. api-gateway gets `POST /api/v1/auth/login` + `POST /api/v1/auth/refresh` + canary `GET /api/v1/whoami` + `GET /api/v1/admin/echo`.
- **WS upgrade verifies JWT + role mapping** (#153, **T-504b**) — `/ws/v1/airport/:airportId/events` reads the token from `Sec-WebSocket-Protocol: bearer.<token>` (the only header the browser WebSocket API exposes) or the `?access_token=` query fallback; closes with `4401` on missing/malformed/wrong-kind tokens. auth role → `ClientRole`: admin/reviewer → `supervisor`, operator → `operator`.
- **Cross-service RBAC rollout** (#154, **T-504c**) — every protected route on incident-service, audit-service, notification-service, validation-engine, reference-data now runs `verifyJwtHook` + `requireRole(...rolesFor(perm))`. Two new permissions added to the matrix (`incident.create`, `reference.read`). New `__TEST__/helpers/auth.ts` exposes `makeTestSigner` + `operatorToken` / `reviewerToken` / `adminToken` + `bearer()` so service tests don't duplicate the boilerplate.
- **Frontend auth — login + bearer-on-fetch + RBAC UI gates** (#155, **T-504d**) — `useAuthStore` owns `{ accessToken, refreshToken, user }` and persists to `localStorage` (XSS-readable; documented as demo-only). New `/login` page with email-only + three quick-pick demo accounts. Global `auth.global.ts` middleware bounces unauthenticated traffic to `/login?next=…`. `IncidentApi` + `AuditApi` accept `tokenProvider` + `onUnauthorized` — every request attaches `Authorization: Bearer <token>` and a 401 invokes the refresh callback once. `WsClient` opens with `Sec-WebSocket-Protocol: bearer.<token>` so the WS path matches the HTTP path. `usePermission(perm)` composable wraps `isAllowed(role, perm)` so UI gates match the backend's contract exactly.

#### Input safety (`packages/http-safety`)

- **Shared error envelope + body limit + rate limit** (#156, **T-505**) — `safeErrorHandler` + `safeNotFoundHandler` lifted out of api-gateway into `@aip/http-safety` so every service emits the same `{ error: { code, message, correlation_id? } }`. 5xx messages are scrubbed; 4xx echoes the original so validation feedback survives. `DEFAULT_BODY_LIMIT_BYTES` = 256 KiB passed to every service's Fastify constructor. api-gateway adds `@fastify/rate-limit` with a 240/min global per-IP budget; auth routes (`/api/v1/auth/login`, `/api/v1/auth/refresh`) tighten to **20/min** via the `config.rateLimit` per-route override.

#### Security audit events (`packages/security-events`)

- **Audit chain captures auth + access + rate-limit events** (#157, **T-506**) — every security-relevant action lands in the same hash-chained audit log that already captures incident transitions. New `SecurityEvent` envelope (`event_id`, `event_type`, `schema_version`, `source`, `timestamp`, `actor_user_id`, `subject_id`, `correlation_id?`, `payload`). `RedisSecurityEventPublisher` writes to `events.security.<event_type>`; failures log + count but never throw (a missed audit row is a degradation, not a user-visible failure). api-gateway emits `auth.login.{succeeded,failed}` + `auth.refresh.{succeeded,failed}` from the auth routes, `access.denied` via an `onResponse` hook on any 401/403 outside the auth surface, and `rate_limit.blocked` via `@fastify/rate-limit`'s `onExceeded` callback. audit-service grows a `SecurityEventsSubscriber` that psubscribes to `events.security.*` and writes each envelope as an `audit_events` row via the same `AuditChainWriter` the incident subscriber uses.

#### Dockerized integration tier

- **Real-stack e2e job + smoke spec** (#159, **T-507**) — sibling `playwright.integration.config.ts` runs against the live `docker-compose` stack (nginx-fronted on `:3000`) rather than the mocked tier. New `__TEST__/e2e/integration/00-real-stack-smoke.spec.ts`: real `POST /api/v1/auth/login` through nginx → api-gateway returns a JWT pair; `GET /api/v1/whoami` round-trips the access token; an authenticated browser session lands on `/` not `/login`. New `.github/workflows/e2e-integration.yml` builds images, brings the data plane up, migrates + seeds the schema, brings the rest of the stack up, runs `pnpm e2e:integration`, dumps `docker compose logs` as artifacts on failure. The mocked tier (`scenarios/`) keeps running on the fast feedback path.

### Fixed

- **Recurring validation-engine CI flake** (#158) — the "valid" payload helpers in `__TEST__/services/validation-engine/app.test.ts` (`validSubmissionPayload()`) and `orchestrator.test.ts` (`validInput()`) called `new Date().toISOString()` twice, producing `captured_at > timestamp` on slow CI runners. L6 (`06_ai_output`) correctly rejected the unphysical payload with `CAPTURED_AT_AFTER_ENVELOPE`. Fix: snapshot `now` once per helper.
- **Seed sensor id violated `sensors_id_chk`** (T-507 follow-up) — `PRM-PERIMETER-N-01` has three hyphens; the schema regex `^[A-Z]{2,4}-[A-Z0-9]+-[0-9]{2,3}$` requires exactly two. Renamed to `PRM-PERIMN-01` in both seed sources. Surfaced for the first time in the new integration job's `db:seed` step.
- **Service Dockerfiles couldn't find tsx at runtime** (T-507 follow-up) — `CMD ["node", "--enable-source-maps", "--loader=tsx", "services/X/src/main.ts"]` resolves `tsx` from the CWD (`/app/`), but pnpm workspaces install dev-deps at `services/X/node_modules/tsx`. All 9 Node service Dockerfiles now invoke the service-local `tsx` bin directly. Crashed every container on first `docker compose up`; surfaced by the new integration job.

## [0.4.0] — 2026-05-30

**Phase 4 — Incident lifecycle + validation pipeline + audit trail + operator workflow.** Detections from Phase 3 now drive a real incident lifecycle: incident-service owns the state machine and REST surface, the Parity 10-layer validation engine certifies (or routes to HITL) every detection, audit-service persists a hash-chained tamper-evident log of every transition, notification-service fans out to in-app + webhook + email channels, the operator dashboard gains an incident timeline + playback UI sourced from the audit log, and an end-to-end Playwright scenario walks the full FOD-on-runway workflow.

### Added

#### Incident lifecycle (`services/incident-service`)

- **State machine + domain events + lifecycle docs** (#131) — pure `IncidentState` machine with typed errors (`IllegalTransitionError`, `TerminalStateError`), `IncidentTransitionedEvent` envelope, and the `incident.transition.<next_state>` channel taxonomy. ADR-quality lifecycle doc covers every legal command + state.
- **REST API — CRUD + filters + cursor pagination + OpenAPI** (#132) — `GET /incidents`, `GET /incidents/:id`, `POST /incidents` with `IdempotencyKeyConflictError` handling. Filters by status/severity/airport/runway/created_at window; cursor-based pagination (base64url of `{created_at, id}`); hand-authored OpenAPI 3.1 doc as source of truth for client codegen.
- **Acknowledgment workflow** (#133) — `POST /incidents/:id/acknowledge` transitions `new → acknowledged`, denormalizes `acknowledged_by` + `acknowledged_at`, and publishes on `incident.transition.acknowledged`. `IncidentEventPublisher` (Redis + Recording variants) + frontend `IncidentApi` + Pinia store with optimistic update + rollback. Publish failure does NOT roll back persistence — a broker flap must never block an operator on an active runway incident.
- **Assignment + escalation workflow — 6 transition routes** (#134) — `assign`, `start_progress`, `resolve`, `escalate`, `archive`, `reject`. All seven endpoints (incl. acknowledge) share a single `registerTransitionRoute` helper; each route only declares its body schema + `denormalize` callback + `reasonOf` extractor. Required-vs-optional bodies are a domain decision: `resolve` demands `resolution_summary`, `escalate`/`reject` demand `reason`, the rest treat the operator note as optional context.

#### Validation engine — 10 Parity layers (`services/validation-engine`)

- **Foundation — shared contracts + prom metrics + production short-circuit** (#135, **ADR 0008**) — `ValidationLayerId`, `ValidationLayerResult`, `ValidationRun`, `ValidationSubmissionRequest` promoted into `@aip/shared-contracts/validation`; three consumers (engine, bridge, UI) share one schema source. `validation_layers_run_total{layer,passed}`, `validation_runs_total{certified}`, `validation_run_duration_seconds` histogram. `shortCircuit: true` is the production default — stops at the first failing layer instead of running L2..L10 against garbage.
- **L1 input validation — envelope shape + timestamp window + geo bounds** (#136) — collects every failure in a single pass (operators see all L1 issues at once); configurable clock + skew bounds default to ±5min future / 24h past.
- **L2 schema & contract validation** (#137) — `EventEnvelope` zod parse, `schema_version` allowlist (default `["v1"]`), event-type-specific payload schemas (`SensorFramePayload` / `AiDetectionPayload`). Wire-format note: validator-side `AiDetectionPayload` mirrors the Python publisher's short class names while the long-name TS enum reconciliation lands later.
- **L3 business rules — SOP-driven policy** (#138) — FOD min-dimension + location-severity matrix, crack severity bands, snowbank height + setback, wildlife high-risk severity floor. Defaults in `sop-thresholds.ts` mirror `data/seed/reference/sop-baseline.json` — explicit drift > silent drift.
- **L4 source-of-truth + L5 cross-system — reference-data integration** (#139) — `ReferenceDataClient` interface, `InMemoryReferenceDataClient` for tests, default-pass when no client is configured. L4: `SENSOR_NOT_FOUND` / `AIRPORT_NOT_FOUND`. L5: `SENSOR_AIRPORT_MISMATCH` / `SENSOR_OFFLINE_AT_CAPTURE`; defers to L4 on missing entities (no double-fail).
- **L6 AI output sanity + L7 risk scoring** (#140) — L6: bbox extent ≤ 1, confidence ≥ floor, evidence linkage non-sentinel + non-duplicate, captured_at within envelope skew. L7: transparent named-factor score (`confidence_gap`, `freshness`, `severity_weight`, `prior_failure_density`) with explicit weights; `routes_to_hitl` signal for L8 + `RISK_EXCEPTION_THRESHOLD` hard-fail at 0.95. Operator-trust property over black-box score.
- **L8 HITL + L9 audit emission + L10 certification — pipeline complete** (#141) — L8 produces `details.hitl = {routed_to_hitl, priority, reasons[]}`; L9 hands a `ValidationAuditRecord` to an optional `AuditSink`; L10 gates with `HITL_PENDING` / `CERTIFICATION_INELIGIBLE` / pass + `details.certification`. All 10 layers live.

#### Audit + notification

- **Audit-service — hash-chained append-only log** (#142, **ADR 0010 detection layer**) — `entry_hash = sha256(prev_hash || canonical_json(entry))` with transactional INSERT under `pg_advisory_xact_lock` so concurrent writers serialize on the chain tip. `incident.transition.*` Redis subscriber persists every state transition. Operator HTTP surface: `GET /audit/events` (paginated), `GET /audit/events/:event_id`, `GET /audit/lineage/:subject_id`, `POST /audit/verify` (recompute hashes over a range, capped at 1000 rows).
- **Notification-service — live channels + DLQ** (#143) — three channels with a uniform `NotificationChannel { appliesTo, deliver }` interface: `in_app` (Redis publish to `events.broadcast.<airport_id>`), `webhook` (HTTP POST with exponential backoff retry + in-memory DLQ), `email` (stub: logs + recipient). `IncidentNotificationsSubscriber` dedupes by `event_id` over a sliding LRU. `GET /channels`, `/deliveries`, `/deliveries/dlq` for operator inspection.

#### Operator dashboard (`apps/web`)

- **Incident timeline + playback** (#144) — `AuditApi.lineage(subject_id)` read-only client, pure `buildIncidentTimeline()` helper that prepends an implicit `created` step at the from-state of the first transition + sorts by `occurred_at`. `useIncidentTimeline` composable owns the reactive cursor (`steps`, `currentStep`, `prev/next/jumpToLast`, `setCursor`). `IncidentTimeline.vue` renders numbered steps + slider + "State at cursor" snapshot. Deep-link page at `/incidents/:id`. `data-testid` on every interactive surface for future Playwright drives.

#### Pipeline ops (`services/event-pipeline`)

- **Replay queue worker — recovers late-beyond-window frames** (#145) — drains `ReplayQueue` (T-207) on an interval and re-dispatches each item straight to the persist handler, bypassing the prioritization wrapper on purpose (the watermark has advanced; re-classifying would loop forever). `inFlight` guard collapses overlapping ticks; `stop()` awaits the in-flight tick. Metrics: `replay_drained_total{outcome}`, `replay_dispatch_duration_seconds`.

#### Quality + observability

- **Playwright scenario 07 — FOD on active runway, full operator workflow** (#146) — capstone E2E. Pushes a critical FOD detection through the ws-fixture and verifies the alert feed; mocks audit-service `/audit/lineage` and walks the timeline through `created → acknowledged → assigned → in_progress → resolved` with the slider + prev/next/last controls. The real-stack variant ships in T-507.

### Test counts

- `@aip/incident-service`: **101 tests** (state machine + REST CRUD + 7 transition routes + acknowledge dedicated suite)
- `@aip/validation-engine`: **144 tests** (10 layers + orchestrator + HTTP)
- `@aip/audit-service`: **33 tests** (hash chain + writer + subscriber + HTTP routes)
- `@aip/notification-service`: **28 tests** (3 channels + registry + subscriber + HTTP)
- `@aip/event-pipeline`: **104 tests** (+8 for the replay queue worker)
- `@aip/web` (unit): **112 tests** (+18 for the incident timeline + audit client + composable)
- Playwright e2e: **scenario 07** added (FOD-on-runway full workflow)

### Architecture decisions

- **ADR 0008 — Parity 10-layer validation pipeline** (Accepted). Layer ids, ordering, run envelope live in `@aip/shared-contracts`; orchestrator owns short-circuit + per-layer metrics; named-factor risk score over a black-box ML scorer for operator trust.

### Carried into Phase 5 backlog

- Bounding-box overlay on the live map (data flows through; component lands with the incident detail panel integration).
- `RestReferenceDataClient` + `RestAuditSink` wiring for the validation engine ↔ reference-data + audit-service paths (interfaces ship; HTTP impl deferred to keep wiring concerns isolated).
- TS `DetectionClass` enum reconciliation with the Python publisher's wire names.
- Validation-engine ↔ event-pipeline bridge (POST /validate before incident creation; today the engine is callable but not wired into the live ingestion path).
- Dockerized full-stack e2e (T-507) covers real audit-service + real reference-data paths.

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
