# For the interview panel

A ≈5-minute read. This project exists to show how I build a **production-shaped** system, not just a working one. Every claim below links to the artifact that backs it — the point is that you can verify, not just trust.

## What it is

An AI-assisted airport inspection platform. Sensors stream frames; a (simulated) computer-vision service emits hazard detections; a 10-layer validation pipeline scores and routes them; risky ones go to a human-in-the-loop reviewer; confirmed hazards become incidents with a full lifecycle and a tamper-evident audit trail; operators watch it all live. **13 services**, one nginx edge, Redis as the event bus, Postgres as the system of record.

It's deliberately the _boring parts done well_: observability, auth, resilience, failure handling, and tests — the things that separate "it runs on my laptop" from "it could survive a shift."

## What it demonstrates (claim → proof)

| Claim                                          | Proof                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Distributed-systems judgment**               | 13 ADRs explaining the _why_ — [transport](docs/adr/0001-redis-pubsub-vs-kafka.md), [service boundaries](docs/adr/0003-service-boundary-rationale.md), [edge/cloud](docs/adr/0007-edge-cloud-separation.md), [ordering & dedup](docs/adr/0006-event-ordering-and-dedup.md) |
| **Real event-pipeline mechanics**              | dedup window + watermark + bounded replay queue + durable outbox — [event-pipeline](services/event-pipeline/src/), [ADR 0006](docs/adr/0006-event-ordering-and-dedup.md)                                                                                                   |
| **Observability by default**                   | correlated structured logs + RED metrics on every service — [operations/logging.md](docs/operations/logging.md), [operations/metrics.md](docs/operations/metrics.md)                                                                                                       |
| **Security, deny-by-default**                  | JWT + per-route RBAC + rate limiting + a hash-chained audit log — [threat model](docs/operations/threat-model.md), [security tests](__TEST__/security/), [ADR 0011](docs/adr/0011-input-validation-and-auth.md)                                                            |
| **Failure is designed-for, not hoped-against** | 11 failure modes, each with detection/recovery/operator-UX traced to code — [FAILURE_MODE_MATRIX.md](docs/FAILURE_MODE_MATRIX.md)                                                                                                                                          |
| **Resilience is tested, not asserted**         | 7 load + fault-injection scenarios against the live stack — [load suite](__TEST__/load/)                                                                                                                                                                                   |
| **Operable by someone who didn't build it**    | 5 decision-tree runbooks — [docs/runbooks/](docs/runbooks/)                                                                                                                                                                                                                |
| **Safety-critical AI is governed**             | explainable HITL routing with weighted risk thresholds — [ADR 0009](docs/adr/0009-hitl-routing-thresholds.md), [10-layer pipeline](docs/adr/0008-parity-10-layer-validation.md)                                                                                            |
| **Tested at every layer**                      | unit · api · integration · e2e (mocked **and** dockerized full-stack) · security · load — [`__TEST__/`](__TEST__/)                                                                                                                                                         |

## How to run it

```bash
pnpm install && docker compose up -d
pnpm db:migrate && pnpm db:seed
open http://localhost:3000          # log in as pat.operator@airport-ops.test
```

Then follow the **[5-minute demo walkthrough](docs/DEMO_WALKTHROUGH.md)**. Reviewing the code instead? The **[PR review guide](docs/PR_REVIEW_GUIDE.md)** is a guided tour of the parts worth your time.

## Production-engineering concerns I deliberately built in

- **One public surface.** All traffic goes through api-gateway — one auth point, one rate-limit budget, one sanitized error envelope ([ADR 0012](docs/adr/0012-api-gateway-as-public-surface.md)). Services still verify JWTs _locally_ — they never trust the hop ([RBAC matrix test](__TEST__/security/incident-service/rbac-matrix.test.ts)).
- **Graceful, uneven-by-blast-radius degradation.** A Redis flap means the rate limiter fails _open_ (`skipOnError`) and a missed security-audit row is logged-not-thrown — but an incident transition that can't be announced _fails the request_ rather than silently losing the event. These choices are explicit ([failure matrix mode 5](docs/FAILURE_MODE_MATRIX.md)).
- **At-least-once with idempotency.** Every write carries an idempotency key; subscribers dedup; the `event_outbox` table is the durability anchor that survives a DB blip ([ADR 0005](docs/adr/0005-idempotency-and-retries.md)).
- **Tamper-evidence.** The audit log is a SHA-256 hash chain with a `verify` endpoint — security-relevant actions and incident transitions land on the same chain ([ADR 0010](docs/adr/0010-audit-immutability.md)).
- **Traceability.** A correlation id threads a single request across services through logs and audit rows.

## Trade-offs I made for demo speed (and would change in production)

I'd rather state these than have you find them:

- **Redis pub/sub, not Kafka.** No durable log or partitioned ordering — fine for a single-host demo, wrong for multi-region. The [ordering/dedup machinery](docs/adr/0006-event-ordering-and-dedup.md) is consumer-side and **in-memory / single-process** — the first thing to change at scale.
- **The AI is simulated.** Deterministic seeded heuristics with realistic confidence calibration, not a trained model — the point is the _system around_ inference ([ADR 0004](docs/adr/0004-ai-inference-simulation.md)).
- **Demo auth.** Email-only login against a seeded directory (no passwords); tokens in `localStorage`. Real deployment adds credential verification + httpOnly cookies.
- **HITL thresholds are hand-tuned**, not learned ([ADR 0009](docs/adr/0009-hitl-routing-thresholds.md)).
- **Documented gaps** (sensor-silence watchdog, AI circuit breaker, server-side WS hydration) are listed as _production evolution_ in the [failure matrix](docs/FAILURE_MODE_MATRIX.md#production-evolution-known-gaps-by-intent) — not hidden.

## Why this maps to a senior role

The interesting decisions here aren't "which framework" — they're _where to put a boundary, what to do when a dependency dies, how to make a safety-critical automated decision auditable, and how to prove resilience instead of claiming it_. The ADRs, failure matrix, runbooks, and the security + load suites are the evidence that I think about systems past the happy path. The [PR review guide](docs/PR_REVIEW_GUIDE.md) points at the specific files where that judgment shows up.
