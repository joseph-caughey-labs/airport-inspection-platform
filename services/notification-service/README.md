# `notification-service`

Outbound notification fanout for incident lifecycle events. Channels: in-app (WebSocket), webhook (HTTP POST), email (stub). This PR lands the **shell** — Fastify app, healthchecks, Redis wired, stubbed channel registry. Real channel implementations + retry/DLQ arrive in T-413.

## Endpoints

| Method | Path        | Returns                                            |
| ------ | ----------- | -------------------------------------------------- |
| GET    | `/health`   | 200 ok                                             |
| GET    | `/ready`    | 200 when Redis is healthy                          |
| GET    | `/channels` | List of registered channels (currently stubs only) |

## What's not here yet

- Redis subscribers on `incident.lifecycle.*` and `notification.*` channels (T-413)
- In-app channel publishing to ws-broadcaster (T-413)
- Webhook delivery with retry + DLQ (T-413)
- Email channel stub (logs payload; real send is out of demo scope)

## Configuration

| Var          | Default |
| ------------ | ------- |
| `PORT`       | `3008`  |
| `REDIS_HOST` | `redis` |
