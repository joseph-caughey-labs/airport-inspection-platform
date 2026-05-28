# `sensor-gateway`

Sensor telemetry ingestion. This PR lands only the **shell** — Fastify app, healthchecks, Redis connection wired up. Real simulators and fault injection arrive in Phase 2 (T-201 → T-204).

## Endpoints

| Method | Path      | Returns                                      |
| ------ | --------- | -------------------------------------------- |
| GET    | `/health` | 200 ok                                       |
| GET    | `/ready`  | 200 when Redis answers `PING`; 503 otherwise |

## What's not here yet

- Camera / LiDAR / GPS / IMU / weather / perimeter simulators (T-201–T-203)
- Fault injection (T-204)
- Actual publishing to `sensor.frame.*` channels (T-201)

## Configuration

| Var          | Default |
| ------------ | ------- |
| `PORT`       | `3003`  |
| `LOG_LEVEL`  | `info`  |
| `REDIS_HOST` | `redis` |
| `REDIS_PORT` | `6379`  |
