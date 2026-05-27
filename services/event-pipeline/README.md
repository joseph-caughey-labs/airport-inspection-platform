# `event-pipeline`

Operational intelligence layer: enrichment, deduplication, prioritization, ordering, persistence, replay. This PR lands only the **shell** — Fastify app, healthchecks, Redis subscriber + Postgres pool wired up. Real consumers and pipeline stages arrive in Phase 2 (T-205 → T-208).

## Endpoints

| Method | Path      | Returns                                                |
| ------ | --------- | ------------------------------------------------------ |
| GET    | `/health` | 200 ok                                                 |
| GET    | `/ready`  | 200 when both Redis and Postgres answer; 503 otherwise |

## What's not here yet

- Redis consumers for `sensor.frame.*` and `ai.detection.*` (T-205)
- Deduplication via idempotency keys + fingerprints (T-206)
- Prioritization + out-of-order watermark buffer (T-207)
- Persistence + outbox + WS broadcast publishers (T-208)

## Configuration

| Var             | Default              |
| --------------- | -------------------- |
| `PORT`          | `3004`               |
| `LOG_LEVEL`     | `info`               |
| `REDIS_HOST`    | `redis`              |
| `POSTGRES_HOST` | `postgres`           |
| `POSTGRES_USER` | `airport_ops`        |
| `POSTGRES_DB`   | `airport_inspection` |
