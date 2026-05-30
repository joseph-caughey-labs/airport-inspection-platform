# `event-pipeline`

Operational intelligence layer: deduplication, prioritization + watermark routing, persistence + outbox publish, AI detection bridge, and (as of **T-415**) the replay queue worker that recovers late frames.

## Endpoints

| Method | Path      | Returns                                                |
| ------ | --------- | ------------------------------------------------------ |
| GET    | `/health` | 200 ok                                                 |
| GET    | `/ready`  | 200 when both Redis and Postgres answer; 503 otherwise |

## Pipeline composition (outside-in)

```
incoming Redis msg → idempotency dedup → prioritization (watermark) → persist + outbox
                                              ↓ late_beyond_window
                                         ReplayQueue
                                              ↑ drains every interval
                                         ReplayQueueWorker → persist + outbox
```

- **Dedup** collapses repeat publishes within `DEDUP_WINDOW_MS` (default 5s).
- **Prioritization** computes a priority histogram per frame + classifies ordering against the per-sensor watermark. `late_beyond_window` frames are diverted to `ReplayQueue` instead of dispatched.
- **Persist + outbox** writes the canonical row + an event-outbox row inside one transaction; the `OutboxWorker` polls and publishes the broadcast.
- **Replay queue worker** (T-415) drains the queue on an interval and re-dispatches each item directly to the persist handler. It bypasses the prioritization wrapper on purpose — re-running the watermark check on a known-late frame would loop forever.

## Replay queue worker (T-415)

`ReplayQueueWorker` runs a single interval-driven drain loop. On each tick:

1. `queue.drain(batchSize)` — pull up to N items in enqueue order.
2. For each item, hand the raw payload to the persist handler.
3. Record per-item outcome on `replay_drained_total{outcome="processed"|"errored"}` and duration on `replay_dispatch_duration_seconds`.

Overlapping ticks are collapsed via an `inFlight` guard — a slow persist run can't queue parallel drains. `stop()` clears the timer and waits for any in-flight tick to finish so we don't leave a half-dispatched batch on shutdown.

## Metrics

| Metric                                                      | Labels    | What it measures                                                          |
| ----------------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| `frame_priority`                                            | `tier`    | Computed priority per processed frame, by tier                            |
| `frame_order_total`                                         | `status`  | Ordering classifications (in_order / late_in_window / late_beyond_window) |
| `replay_enqueue_total`                                      | `outcome` | Replay-queue enqueue outcomes (accepted / dropped on eviction)            |
| `replay_drained_total` _(T-415)_                            | `outcome` | Drained items by terminal outcome (processed / errored)                   |
| `replay_dispatch_duration_seconds` _(T-415)_                | —         | Wall-clock duration of a single replay dispatch                           |
| outbox + ai-detection metrics from their respective workers |

## Configuration

| Var                      | Default              | Notes                                                              |
| ------------------------ | -------------------- | ------------------------------------------------------------------ |
| `PORT`                   | `3004`               |                                                                    |
| `LOG_LEVEL`              | `info`               |                                                                    |
| `REDIS_HOST`             | `redis`              |                                                                    |
| `POSTGRES_HOST`          | `postgres`           |                                                                    |
| `POSTGRES_USER`          | `airport_ops`        |                                                                    |
| `POSTGRES_DB`            | `airport_inspection` |                                                                    |
| `CONSUMERS_DISABLED`     | unset                | When `true`, the subscriber + outbox + replay workers don't start. |
| `DEDUP_WINDOW_MS`        | `5000`               | Idempotency dedup window.                                          |
| `WATERMARK_TOLERANCE_MS` | `30000`              | Late-but-acceptable tolerance for the per-sensor watermark.        |
| `REPLAY_QUEUE_MAX`       | `1024`               | Bounded replay queue capacity; over-capacity evicts the oldest.    |
| `REPLAY_INTERVAL_MS`     | `500`                | _(T-415)_ Replay worker drain interval.                            |
| `REPLAY_BATCH_SIZE`      | `50`                 | _(T-415)_ Max items processed per drain tick.                      |
| `OUTBOX_INTERVAL_MS`     | `250`                | Outbox worker poll interval.                                       |
| `OUTBOX_BATCH_SIZE`      | `100`                | Outbox poll batch size.                                            |
| `DEFAULT_AIRPORT_ID`     | unset                | When set, the AI detection bridge starts.                          |
