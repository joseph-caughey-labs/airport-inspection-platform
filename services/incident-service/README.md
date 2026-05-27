# `incident-service`

Incident lifecycle CRUD + state machine. This PR lands only the **shell** — Fastify app, healthchecks, Postgres pool, and a placeholder `GET /incidents` returning an empty list. Real lifecycle (states, workflows, audit emission) arrives in Phase 4 (T-401 → T-404).

## Endpoints

| Method | Path         | Returns                                  |
| ------ | ------------ | ---------------------------------------- |
| GET    | `/health`    | 200 ok                                   |
| GET    | `/ready`     | 200 when Postgres answers; 503 otherwise |
| GET    | `/incidents` | `{ items: [], total: 0 }` — placeholder  |

## What's not here yet

- State machine (new → acknowledged → assigned → in_progress → resolved + side branches) (T-401)
- REST CRUD with filters (T-402)
- Acknowledge / assign / escalate / resolve workflows (T-403, T-404)
- Audit emission per transition

## Configuration

| Var             | Default    |
| --------------- | ---------- |
| `PORT`          | `3006`     |
| `POSTGRES_HOST` | `postgres` |
