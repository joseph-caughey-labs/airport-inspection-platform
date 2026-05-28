# `reference-data` service

The platform's **source-of-truth registry**. Read-only REST API serving airports, runways, sensors, and SOP baseline values. Consumed by:

- **Validation engine** (Layer 4 — source-of-truth comparison).
- **Operator dashboard** (airport/runway selection, sensor catalog).
- **Frontend reviewer queue** (looking up assets referenced in evidence cards).

Writes happen out-of-band via SQL migrations and seed scripts (T-118). This service deliberately never mutates state.

## Endpoints

| Method | Path                           | Returns                                                                               |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| GET    | `/health`                      | Liveness — always 200 once the process is up.                                         |
| GET    | `/ready`                       | Readiness — 200 when the DB pool answers `SELECT 1`.                                  |
| GET    | `/airports`                    | All airports.                                                                         |
| GET    | `/runways?airport_id=…`        | Runways, optionally filtered by airport.                                              |
| GET    | `/sensors?airport_id=…&type=…` | Sensors with optional filters.                                                        |
| GET    | `/sop-baseline`                | SOP thresholds for the validation engine (placeholder until T-118 lands real values). |

Pagination is intentionally absent — these tables are small (tens to low hundreds of rows). Filtering happens server-side via query params.

## Configuration

Env vars (all have safe defaults for local dev):

| Var                 | Default              | Purpose                                       |
| ------------------- | -------------------- | --------------------------------------------- |
| `PORT`              | `3002`               | Listen port.                                  |
| `LOG_LEVEL`         | `info`               | Logger level.                                 |
| `POSTGRES_HOST`     | `postgres`           | Postgres host (matches Compose service name). |
| `POSTGRES_PORT`     | `5432`               |                                               |
| `POSTGRES_USER`     | `airport_ops`        |                                               |
| `POSTGRES_PASSWORD` | _(REQUIRED)_         |                                               |
| `POSTGRES_DB`       | `airport_inspection` |                                               |

## Local dev

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm --filter @aip/reference-data dev
curl http://localhost:3002/health
```
