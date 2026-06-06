# PR / code review guide

A guided tour for someone evaluating the code. The repo is large (13 services + shared packages); this points you at the ~10 places where the engineering judgment actually lives, so you don't have to spelunk. Budget **20–30 minutes** for the reading path below.

## Orient first (3 min)

- **[README.md](../README.md)** — what it is + the quickstart.
- **[README_INTERVIEW.md](../README_INTERVIEW.md)** — the claim→artifact map; skim it to know what to spot-check.
- **[docs/adr/](adr/)** — the _why_ for every significant decision. If you only read one, read [0003 service boundaries](adr/0003-service-boundary-rationale.md); if two, add [0006 ordering & dedup](adr/0006-event-ordering-and-dedup.md).

## How the repo is organized

- `services/*` — one folder per microservice. Each has the same shape: `src/app.ts` (the Fastify app + routes), `src/main.ts` (composition root / wiring), domain logic in subfolders. `ai-inference` is Python; the rest are Node/TS.
- `packages/*` — shared libraries (`shared-contracts` = the wire types + RBAC policy, `auth-jwt`, `http-safety`, `logger`, `metrics`, `redis-client`, `postgres-client`, `http-client`). Cross-service contracts live here, not duplicated.
- `__TEST__/*` — **all** tests, centralized and mirrored to what they cover (`services/<svc>/`, `unit/<pkg>/`, `security/`, `load/`, `e2e/`). Each service's `vitest.config.ts` globs its slice.
- `docs/*` — ADRs, the failure matrix, runbooks, operations docs.

## The reading path (where the judgment is)

Read these in order — each is small and self-contained:

1. **Contracts as the source of truth** — [`packages/shared-contracts/src/auth/policy.ts`](../packages/shared-contracts/src/auth/policy.ts). The RBAC matrix both backend and frontend read. Notice deny-by-default and that the policy is data, not scattered `if` checks.

2. **Auth done once, applied everywhere** — [`packages/auth-jwt/src/fastify.ts`](../packages/auth-jwt/src/fastify.ts). `verifyJwtHook` + `requireRole(...)` as per-route preHandlers. Then see it _used_ in [`services/incident-service/src/routes/incidents.ts`](../services/incident-service/src/routes/incidents.ts) — each route names the permission it guards, right next to the URL. The point: services verify locally, never trust the gateway.

3. **The event pipeline — the most interesting code** — [`services/event-pipeline/src/main.ts`](../services/event-pipeline/src/main.ts) shows the composition `dedup → prioritize → persist`, then dig into [`dedup/`](../services/event-pipeline/src/dedup/), [`prioritization/`](../services/event-pipeline/src/prioritization/) (watermark + replay queue), and [`persistence/outbox-worker.ts`](../services/event-pipeline/src/persistence/). This is where ordering, dedup, and durability are earned — paired with [ADR 0006](adr/0006-event-ordering-and-dedup.md).

4. **Graceful degradation, made explicit** — compare three publishers' failure behaviour: rate-limit `skipOnError` (api-gateway), [`security-events`](../packages/security-events/src/index.ts) (logs, never throws), and [`incident-service/.../publisher.ts`](../services/incident-service/src/events/publisher.ts) (**throws** — a transition that can't be announced fails the request). Three different right answers by blast radius. The map of all of it: [FAILURE_MODE_MATRIX.md](FAILURE_MODE_MATRIX.md).

5. **Tamper-evidence** — [`services/audit-service/src/chain/`](../services/audit-service/src/chain/) — the hash chain + `verifyChain`. Small, pure, testable; [hash.test.ts](../__TEST__/services/audit-service/hash.test.ts) shows tamper detection.

6. **Shared error + input safety** — [`packages/http-safety/src/index.ts`](../packages/http-safety/src/index.ts). One error envelope, body limits, 5xx scrubbing. Every service installs it.

## How to verify the claims yourself

```bash
pnpm install
pnpm typecheck && pnpm lint           # clean across the workspace
pnpm test                             # unit + integration
pnpm --filter @aip/api-gateway test   # e.g. the gateway's security + rate-limit specs
```

The tests worth opening:

- **Security** — [`__TEST__/security/`](../__TEST__/security/): token forgery (incl. self-minted-admin), the cross-service RBAC matrix, injection/XSS input safety.
- **Load + resilience** — [`__TEST__/load/`](../__TEST__/load/): 7 scenarios; the harness + thresholds are readable even without running the stack.
- **e2e** — [`__TEST__/e2e/`](../__TEST__/e2e/): note the **two tiers** — mocked (fast) and dockerized full-stack (real wire). The integration tier caught two real wiring bugs the mocked tier couldn't (see the v0.6.0 CHANGELOG).

## What to be skeptical of (I'd ask these too)

- **Single-process assumptions.** The watermark + dedup window are in-memory; I call this out as the first thing to break at scale ([ADR 0006](adr/0006-event-ordering-and-dedup.md) trade-offs). Check I was honest.
- **Demo auth.** Email-only login, tokens in `localStorage`. Documented as demo-only; verify it's clearly fenced, not pretending to be production.
- **The "AI."** It's deterministic heuristics ([ADR 0004](adr/0004-ai-inference-simulation.md)). Confidence is calibrated/plausible, not earned — the validation/HITL machinery around it is the real subject.
- **Stale issue tracker.** Some GitHub issues lag behind delivered PRs; the CHANGELOG + merged PRs are the accurate record.

## Conventions you'll see throughout

- **Conventional Commits**, Git Flow (`feature/*` → `develop` squash, `release/*` → `main`).
- **Correlation ids** thread every request through logs + audit rows.
- **Comments explain _why_,** not what; ADRs carry the long-form rationale so the code stays readable.
