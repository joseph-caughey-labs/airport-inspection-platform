# `ws-broadcaster`

WebSocket fanout for the operator and reviewer dashboards. This PR lands the **shell** with one placeholder ping channel; real per-airport channels, presence tracking, and `last_event_id` reconnect resume arrive in Phase 2 (T-209 / T-210).

## Endpoints

| Method | Path          | Purpose                                           |
| ------ | ------------- | ------------------------------------------------- |
| GET    | `/health`     | 200 ok                                            |
| GET    | `/ready`      | 200 when Redis is healthy; 503 otherwise          |
| WS     | `/ws/v1/ping` | Echoes any text frame back, prefixed with `pong:` |

## What's not here yet

- Per-airport / per-role channels (T-209)
- Presence tracking + connection metrics (T-210)
- `last_event_id` resume protocol (T-210)
- WS auth on connection (T-504)
- Backpressure + drop policy (T-210)

## Configuration

| Var          | Default |
| ------------ | ------- |
| `PORT`       | `3005`  |
| `LOG_LEVEL`  | `info`  |
| `REDIS_HOST` | `redis` |
