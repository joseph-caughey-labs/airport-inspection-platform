# Runbook — Replay

**Use when:** events were accepted (sensor frames published, incident transitions made) but didn't reach where they should — the dashboard is empty, the audit chain is behind, or the outbox isn't draining.

**Mental model — the durable path:**

```
publish ─▶ event-pipeline ─▶ persist (DB) ─▶ event_outbox row (published_at NULL)
                                                   │  outbox worker, every ~250ms
                                                   ▼
                                            publish to events.broadcast.<airport>
                                                   │
                                          ┌────────┴─────────┐
                                          ▼                  ▼
                                    ws-broadcaster      audit-service
                                    (dashboard)         (hash chain)
```

The `event_outbox` table is the recovery anchor: anything accepted is durable there until `published_at` is set, so "missing on the dashboard" almost always means _stuck in / behind the outbox_, not _lost_.

## Triage: where did it stop?

```bash
# 1. Is it even persisted + how big is the unpublished backlog?
docker compose exec postgres psql -U airport_ops -d airport_inspection \
  -c "SELECT count(*) AS unpublished FROM event_outbox WHERE published_at IS NULL;"

# 2. Is the outbox worker making progress?
curl -s localhost:3004/metrics | grep -E '^outbox_(published|publish_failures)_total'
```

- **unpublished ≈ 0 and `outbox_published_total` climbing** → events ARE flowing; the problem is downstream → [Dashboard empty](#events-persisted-but-the-dashboard-is-empty).
- **unpublished > 0 and NOT falling** → [Outbox not draining](#outbox-backlog-is-not-draining).
- **unpublished growing fast** → producer outpacing the pipeline → [Backlog growing under load](#backlog-growing-under-load).

## Outbox backlog is not draining

`unpublished > 0`, steady or rising, `outbox_published_total` flat.

### → Is `outbox_publish_failures_total` rising?

```bash
curl -s localhost:3004/metrics | grep '^outbox_publish_failures_total'
```

- **Yes** → the worker is trying but Redis publishes are failing → fix Redis first ([recovery.md › Redis](recovery.md#-redis)). The worker retries each row on its next tick; backlog drains once Redis is healthy. No manual replay needed.
- **No (flat failures, flat published)** → the worker may be wedged or not running:

```bash
docker compose logs --tail=40 event-pipeline | grep -i outbox
# Restart resumes the worker; it picks up published_at IS NULL rows from where it left off.
docker compose restart event-pipeline
```

**Verify it drains:**

```bash
watch -n 2 "docker compose exec -T postgres psql -U airport_ops -d airport_inspection \
  -c \"SELECT count(*) FROM event_outbox WHERE published_at IS NULL;\""   # trending to 0
```

### Inspect the stuck rows (high attempts = poison row)

```bash
docker compose exec postgres psql -U airport_ops -d airport_inspection -c \
  "SELECT event_id, channel, attempts, created_at FROM event_outbox
   WHERE published_at IS NULL ORDER BY attempts DESC LIMIT 10;"
```

A single row with a very high `attempts` while others drain is a poison message — capture it and follow [escalation.md](escalation.md) before deleting anything.

## Events persisted but the dashboard is empty

Outbox is draining (`outbox_published_total` climbing) but operators see nothing.

### → Is ws-broadcaster receiving the broadcasts?

```bash
curl -s localhost:3005/ready                                   # 200?
curl -s localhost:3005/metrics | grep '^ws_broadcaster_received_total'   # climbing?
```

- **received climbing, dashboard still empty** → it's a client-side connection issue, not data. Have the operator reload; the [WsClient](../../apps/web/composables/useWebSocket.ts) reconnects with a resume cursor. Check the browser console for a `4401` (expired token → re-login).
- **received flat** → ws-broadcaster isn't getting the broadcast channel. Restart it (`docker compose restart ws-broadcaster`); it re-subscribes to `events.broadcast.*` on boot.

## Backlog growing under load

`unpublished` and `consumer_depth` rising; `consumer_dropped_total` may be climbing.

This is **bounded backpressure working as designed**, not corruption — the orchestrator sheds at `maxConcurrency` (32) rather than growing without limit (see [FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) mode 4). Options:

```bash
# Give the consumer more headroom, then restart to apply:
#   CONSUMER_MAX_CONCURRENCY=64   (in event-pipeline's environment)
docker compose up -d event-pipeline
```

Then confirm `consumer_dropped_total` stops climbing and `unpublished` falls. If the producer is a runaway simulator, throttle it at the source instead.

## Replay after a service restart

Restarting event-pipeline drops its **in-memory** state (dedup window, watermark, out-of-order replay queue) by design — the DB + outbox are the durable path and the fresh process resumes them. Late/out-of-order frames already past the 30s watermark tolerance and not yet persisted are the only ones that can be lost; new frames process normally. Verify with `consumer_processed_total` climbing after the restart.
