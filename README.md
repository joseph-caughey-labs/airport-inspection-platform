# Airport Inspection Platform

[![CI](https://github.com/joseph-caughey-labs/airport-inspection-platform/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/joseph-caughey-labs/airport-inspection-platform/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20NC%201.0.0-blue.svg)](LICENSE)

A production-style demonstration of an AI-assisted airport inspection platform: real-time sensor ingestion, simulated computer-vision detection, a 10-layer validation pipeline with human-in-the-loop routing, an incident lifecycle with a tamper-evident audit chain, and a live operations dashboard — all wired across 13 services with the observability, auth, resilience, and test coverage a real deployment expects.

> **Reading this for an interview?** Start with **[README_INTERVIEW.md](README_INTERVIEW.md)** (≈5 min) and the **[demo walkthrough](docs/DEMO_WALKTHROUGH.md)**. Reviewing the code? **[docs/PR_REVIEW_GUIDE.md](docs/PR_REVIEW_GUIDE.md)** is the guided tour.

This is a portfolio and demonstration project — not a deployed product, not certified for any operational use.

## Quickstart

**Prerequisites:** Docker, Node 20+, and pnpm 9+ (`corepack enable && corepack prepare pnpm@9.12.0 --activate`).

```bash
pnpm install                 # install workspace deps
docker compose up -d          # bring up the full stack (13 services)
pnpm db:migrate && pnpm db:seed   # schema + demo data (first run only)
open http://localhost:3000    # operator dashboard
```

Wait for the edge to report healthy before opening the dashboard:

```bash
until docker inspect --format='{{.State.Health.Status}}' aip-nginx 2>/dev/null | grep -q healthy; do sleep 3; done
```

Log in with a seeded demo account (`pat.operator@airport-ops.test`, `rio.reviewer@airport-ops.test`, or `alex.admin@airport-ops.test` — email only, no password in demo mode). Full bring-up troubleshooting is in **[docs/runbooks/startup.md](docs/runbooks/startup.md)**.

## What it does

Six demo scenarios drive the system end-to-end — sensor frame → AI detection → 10-layer validation → severity + HITL routing → operator dashboard → incident lifecycle → tamper-evident audit trail → resolution:

| #   | Scenario                           | Shows off                                                            |
| --- | ---------------------------------- | -------------------------------------------------------------------- |
| 1   | FOD on an active runway            | Critical severity → full ack/assign/resolve workflow → audit lineage |
| 2   | Snowbank compliance violation      | SOP-threshold rule → maintenance routing                             |
| 3   | Pavement crack / surface distress  | Classification → severity-band mapping                               |
| 4   | Sensor outage → reconnect → replay | WS reconnect + resume cursor; durable recovery                       |
| 5   | Duplicate false-positive           | Deduplication suppresses the second detection                        |
| 6   | Weather-degraded visibility        | AI confidence degrades → LOW CONF → HITL routing                     |

See the **[demo walkthrough](docs/DEMO_WALKTHROUGH.md)** for the timed, scripted version.

## Architecture

```
            EDGE (sensor-proximate)              CLOUD (aggregation + ops)
        ┌───────────────────────────┐   ┌────────────────────────────────────────┐
sensors │ sensor-gateway            │   │ event-pipeline ─▶ validation-engine      │
   ──▶  │   └─▶ sensor.frame.captured│──▶│   (dedup, order, persist, outbox)        │
        │ ai-inference (Python)     │   │ incident-service   audit-service          │
        │   └─▶ ai.detection.*      │   │ notification-service  reference-data      │
        └───────────────────────────┘   │ ws-broadcaster ─▶ operator dashboard (web)│
                  Redis pub/sub seam     └────────────────────────────────────────┘
                                          api-gateway = the single public surface
                                          (auth · RBAC · rate-limit · one error envelope)
```

13 services behind an nginx edge; Redis pub/sub is the event transport and the edge/cloud seam; Postgres is the system of record (incidents + a hash-chained audit log). Every backend service emits structured logs (correlated) + RED metrics, verifies JWTs locally, and degrades gracefully under dependency failure. The **why** behind each choice lives in the [ADRs](docs/adr/).

## Engineering surface (the point of the project)

| Concern                    | Where                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Architecture decisions** | [docs/adr/](docs/adr/) — 13 ADRs (transport, boundaries, AI sim, ordering/dedup, edge/cloud, HITL, audit, auth)                                  |
| **Failure handling**       | [docs/FAILURE_MODE_MATRIX.md](docs/FAILURE_MODE_MATRIX.md) — 11 modes, each traced to code                                                       |
| **Operations**             | [docs/runbooks/](docs/runbooks/) — startup · recovery · replay · escalation · troubleshooting                                                    |
| **Observability**          | [docs/operations/](docs/operations/) — logging, metrics, auth, threat model                                                                      |
| **Security**               | JWT + deny-by-default RBAC + rate limiting + audit chain; [security tests](__TEST__/security/) + [threat model](docs/operations/threat-model.md) |
| **Resilience**             | [load + resilience suite](__TEST__/load/) — 7 scenarios against the live stack                                                                   |
| **Tests**                  | `__TEST__/` — unit, api, integration, e2e (incl. a dockerized full-stack tier), security, load                                                   |

## Commands

```bash
pnpm test            # unit + integration across the workspace
pnpm test:e2e        # Playwright (mocked tier) + dockerized integration tier
pnpm test:load       # load + resilience suite (needs the stack up)
pnpm lint            # eslint via turbo
pnpm typecheck       # tsc --noEmit across packages
pnpm format:check    # prettier
```

## Workspace layout

| Folder                               | Purpose                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [`apps/`](apps/)                     | Nuxt 3 operator + reviewer dashboard                                                                |
| [`services/`](services/)             | 13 backend microservices (Node/TS + the Python AI service)                                          |
| [`packages/`](packages/)             | Shared libraries (contracts, logger, metrics, auth-jwt, http-client/safety, redis/postgres clients) |
| [`__TEST__/`](__TEST__/)             | Centralized tests — unit, api, integration, frontend, pipeline, e2e, **security**, **load**         |
| [`docs/`](docs/)                     | ADRs, runbooks, failure-mode matrix, operations + architecture docs, demo walkthrough               |
| [`infrastructure/`](infrastructure/) | Docker, nginx, DB init, env templates                                                               |
| [`data/`](data/)                     | Seed data + the 6 demo [scenarios](data/scenarios/)                                                 |

## Process

Git Flow: `main` is always demo-runnable, `develop` is integration, work flows through `feature/*` → `develop` (squash) and `release/*` → `main`. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [ADR 0012](docs/adr/0012-api-gateway-as-public-surface.md).

## License

Licensed under [PolyForm Noncommercial 1.0.0](LICENSE) — code review, evaluation, and noncommercial use are permitted; commercial use and redistribution are not. See [`NOTICE.md`](NOTICE.md) and [`TERMS_OF_USE.md`](TERMS_OF_USE.md).
