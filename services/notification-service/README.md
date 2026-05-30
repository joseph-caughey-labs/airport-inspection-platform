# `notification-service`

Outbound notification fanout for incident lifecycle events. **T-413 (this PR)** lands the three live channels (in-app, webhook, email-stub), the Redis subscriber on `incident.transition.*`, dedup by `event_id`, and the operator HTTP surface for inspecting recent deliveries + the webhook DLQ.

## Endpoints

| Method | Path              | Returns                                                            |
| ------ | ----------------- | ------------------------------------------------------------------ |
| GET    | `/health`         | 200 ok                                                             |
| GET    | `/ready`          | 200 when Redis is healthy                                          |
| GET    | `/channels`       | Live status — every registered channel name                        |
| GET    | `/deliveries`     | Recent `DeliveryResult` rows, most-recent first. `?limit=` clamps. |
| GET    | `/deliveries/dlq` | In-memory webhook DLQ contents (one row per final-attempt failure) |

## Channels

| Channel   | What it does                                                                          | Default `appliesTo`              |
| --------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| `in_app`  | `redis.publish events.broadcast.<airport_id>` for the ws-broadcaster fanout to the UI | every event                      |
| `webhook` | HTTP `POST` with exponential backoff retry; failures land in an in-memory DLQ         | `event_type` allowlist + URL set |
| `email`   | **stub** — logs the payload + recipient. Real SMTP/SES integration is its own ticket. | allowlist (default: every event) |

Channels live in `src/channels/`. Each one implements `NotificationChannel { appliesTo(event), deliver(event): DeliveryResult }` — the registry runs `deliver` in parallel for every applicable channel; skipped channels still surface a `status="skipped"` row on `/deliveries` so the operator sees the full fanout picture.

## Subscriber

`IncidentNotificationsSubscriber.psubscribe("incident.transition.*")` lives on its own Redis client (pub/sub mode can't share with `PUBLISH` usage). For every message it:

1. Parses the envelope — drops malformed JSON / wrong event_type / non-UUID `incident_id` (counted, logged, never throws).
2. Dedupes on `event_id` over a sliding in-memory LRU (`idempotencyWindow`, default 1000). ioredis delivery is at-least-once and the publisher may retry; deduping here keeps the operator UI / webhook / email from double-firing.
3. Dispatches through the registry → all applicable channels in parallel.

For production, the LRU swaps for a Redis SETEX-backed dedup window; the subscriber interface doesn't change.

## Webhook retries + DLQ

`WebhookChannel` runs up to `maxAttempts` (default 3) with `initialBackoffMs * 2^(n-1)` between tries. A final failure pushes the `DeliveryResult` onto the in-memory DLQ. The DLQ is intentionally in-memory for the demo — `GET /deliveries/dlq` reads it. Production would back this with a persistent queue (Redis stream, Postgres table, S3 dropbox); the channel API doesn't need to change.

## Configuration

| Var           | Default | Notes                                                                           |
| ------------- | ------- | ------------------------------------------------------------------------------- |
| `PORT`        | `3008`  |                                                                                 |
| `REDIS_HOST`  | `redis` |                                                                                 |
| `WEBHOOK_URL` | _empty_ | When unset, the webhook channel reports `appliesTo() = false` and stays silent. |
