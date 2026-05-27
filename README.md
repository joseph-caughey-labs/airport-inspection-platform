# Airport Inspection Platform

A production-style demonstration of an AI-assisted airport inspection platform: real-time sensor ingestion, computer-vision event detection, 10-layer validation, and an operations dashboard.

## Status

Phase 1 in progress — monorepo skeleton landed. No services running yet; the workspace is the rails.

## Prerequisites

- **Node.js 20+** (see [`.nvmrc`](.nvmrc))
- **pnpm 9+** (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- **Docker** (for Phase 1+ once services land)

## Quickstart

```bash
pnpm install            # install workspace deps
pnpm lint               # lint via turbo
pnpm typecheck          # tsc --noEmit across packages
pnpm test               # run all tests
pnpm format:check       # prettier check
```

Once services land in subsequent tickets:

```bash
docker compose up       # full stack (Phase 1 brings up the skeleton; Phase 2+ adds telemetry)
```

## Workspace Layout

| Folder | Purpose |
|---|---|
| [`apps/`](apps/) | Frontend applications (Nuxt 3 operator + reviewer dashboard) |
| [`services/`](services/) | Backend microservices (Node/TS + Python AI service) |
| [`packages/`](packages/) | Shared workspace libraries (contracts, logger, metrics, clients) |
| [`infrastructure/`](infrastructure/) | Docker Compose, NGINX, DB migrations, env templates, scripts |
| [`data/`](data/) | Seed data, fixtures, demo scenarios |
| [`__TEST__/`](__TEST__/) | Centralized test suite (unit, integration, api, frontend, pipeline, e2e, load, security) |
| [`docs/`](docs/) | ADRs, runbooks, architecture diagrams, demo walkthrough |

## Process

This repo follows **Git Flow**: `main` is always demo-runnable, `develop` is the integration branch, all work flows through `feature/*`, `release/*`, and `hotfix/*` branches.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the short-form process reference. Authoritative long-form planning lives alongside the project brief, role catalog, folder structure, and sprint plans in the planning folder.

## License

Phase 1 will add `LICENSE`, `NOTICE.md`, and `TERMS_OF_USE.md`. Until then, this repository is **not** licensed for redistribution or commercial use — it is provided for portfolio evaluation only.
