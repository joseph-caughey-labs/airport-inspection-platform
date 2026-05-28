# `audit-service`

Append-only audit log with hash-chained tamper evidence. This PR lands the **shell** — Fastify app, healthchecks, Postgres + Redis wired, placeholder `/audit/events` endpoint. The hash-chain INSERT path lands in T-412.

`audit_events` is enforced append-only at the DB role level by [ADR 0010](../../docs/adr/0010-audit-immutability.md).

## Endpoints

| Method | Path            | Returns                                      |
| ------ | --------------- | -------------------------------------------- |
| GET    | `/health`       | 200 ok                                       |
| GET    | `/ready`        | 200 when both Redis and Postgres are healthy |
| GET    | `/audit/events` | `{ items: [], total: 0 }` — placeholder      |

## What's not here yet

- Subscribers for `audit.*` Redis channels (T-412)
- Hash-chain INSERT path (T-412)
- `GET /audit/lineage/:subject_id` (T-412)
- Tamper-detection / verification endpoint (T-412)

## Configuration

| Var             | Default    |
| --------------- | ---------- |
| `PORT`          | `3007`     |
| `REDIS_HOST`    | `redis`    |
| `POSTGRES_HOST` | `postgres` |
