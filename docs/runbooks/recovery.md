# Runbook — Recovery

**Use when:** a dependency (Redis / Postgres) or a service is down and you need to get it back, then confirm no data was lost.

**First, scope the blast radius:**

```bash
docker compose ps
for p in 3001 3003 3004 3005 3006 3007 3008; do
  printf "%s " $p; curl -s -o /dev/null -w "%{http_code}\n" localhost:$p/ready; done
```

- **Many services 503 at once** → a shared datastore is down → [Datastore down](#a-datastore-is-down).
- **One service 503 / crash-looping** → [A single service is down](#a-single-service-is-down).
- **Everything 200 but data looks wrong/missing** → events likely stuck → [replay.md](replay.md).

## A datastore is down

### → Redis

Symptom: live feed frozen, `*_publish_failures_total` climbing, services depending on Redis return 503. The edge (api-gateway) **stays up** — its rate limiter runs `skipOnError`, so REST keeps serving.

```bash
docker inspect --format='{{.State.Health.Status}}' aip-redis
docker compose logs --tail=30 redis
docker compose restart redis     # or: docker compose up -d redis
```

**What recovers on its own:** every service's ioredis client reconnects (100ms→5s backoff, 20 attempts); the event-pipeline subscriber re-subscribes; the outbox worker resends unpublished rows on its next tick. **You do not need to restart the consumers.**

**Verify:**

```bash
docker inspect --format='{{.State.Health.Status}}' aip-redis        # healthy
curl -s localhost:3004/ready                                        # 200
# processed counter advancing again:
curl -s localhost:3004/metrics | grep '^consumer_processed_total'
```

If the live feed is still empty after Redis is healthy → [replay.md › Broadcast didn't reach clients](replay.md#events-persisted-but-the-dashboard-is-empty).

### → Postgres

Symptom: writes/reads 503 with a sanitized error envelope; `event-pipeline /ready` is 503; `consumer_errors_total` rising.

```bash
docker inspect --format='{{.State.Health.Status}}' aip-postgres
docker compose logs --tail=30 postgres
docker compose restart postgres
```

**What recovers on its own:** the pg pool reconnects (5s connect / 30s statement timeout means queries failed fast rather than hanging); **the `event_outbox` is the durability anchor** — events accepted before the outage persisted with `published_at IS NULL` and resend after recovery, so the DB blip doesn't lose events.

**Verify:**

```bash
curl -s localhost:3004/ready          # 200 (checks Redis AND Postgres)
docker compose exec postgres psql -U airport_ops -d airport_inspection \
  -c "SELECT count(*) FROM event_outbox WHERE published_at IS NULL;"   # should trend to 0
```

If the unpublished count is **stuck > 0 and not falling** → [replay.md › Outbox backlog not draining](replay.md#outbox-backlog-is-not-draining).

## A single service is down

```bash
docker compose logs --tail=50 <service>
docker compose restart <service>
sleep 5 && curl -s localhost:<port>/ready
```

- **200** → done. Stateless services (api-gateway, ws-broadcaster, validation-engine, reference-data) recover fully on restart with no data implications.
- **Still 503 / crash-looping** → `docker compose up -d --force-recreate <service>`, then if still bad go to [troubleshooting.md](troubleshooting.md#a-service-is-unhealthy-503-or-crash-looping).

### Special cases

- **event-pipeline restarted** → in-flight (in-memory) dedup window + watermark + replay queue are lost by design; the durable path is the DB + outbox, which the fresh process resumes. New frames process immediately; confirm with `consumer_processed_total` climbing. (This is exactly [load scenario 07](../../__TEST__/load/scenarios/07-replay-after-restart.scenario.ts).)
- **incident-service** → its event publisher **throws** on a Redis publish failure (a transition that can't be announced fails the request rather than silently losing it). If transitions are 5xx-ing, fix Redis first (above), then retry the transition.
- **ws-broadcaster** → connected dashboards auto-reconnect (exponential backoff + `?last_event_id=` resume cursor); no operator action needed beyond restarting the service.

## After recovery — confirm integrity

```bash
# Audit hash-chain still verifies end-to-end (POST; reviewer-gated):
curl -s -X POST localhost:3007/audit/verify \
  -H "Authorization: Bearer <reviewer-token>" | jq .        # { verified: true }
# No lingering unpublished events:
docker compose exec postgres psql -U airport_ops -d airport_inspection \
  -c "SELECT count(*) FROM event_outbox WHERE published_at IS NULL;"
```

`verified:false` → an audit row was tampered or a write was lost; capture `broken_at` and follow [escalation.md](escalation.md).
