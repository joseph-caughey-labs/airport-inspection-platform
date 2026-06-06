# Runbook — Startup

**Use when:** bringing the stack up from cold, or a single service won't reach `ready`.

**Prerequisites:** Docker running; ports 3000–3008, 5432, 6379, 8000 free.

## Cold start

```bash
docker compose up -d
```

Compose starts Postgres + Redis first and gates every other service on their healthchecks (`depends_on: { condition: service_healthy }`), so you don't need to stagger the bring-up yourself.

Wait for the edge to report healthy — it transitively gates web + api-gateway + ws-broadcaster:

```bash
until docker inspect --format='{{.State.Health.Status}}' aip-nginx 2>/dev/null | grep -q healthy; do
  echo "waiting for edge…"; sleep 3; done
```

First boot only — apply schema + seed the demo data:

```bash
pnpm db:migrate && pnpm db:seed
```

**Verify the whole stack is ready:**

```bash
for p in 3001 3003 3004 3005 3006 3007 3008; do
  printf "%s " $p; curl -s -o /dev/null -w "%{http_code}\n" localhost:$p/ready; done
# all 200 → healthy. Any 503 → follow the tree below.
```

## A service won't become ready

Start here when `docker compose ps` shows a container `up` but its `/ready` returns 503 (or it's stuck `restarting`).

### → Is it Postgres or Redis itself that's unhealthy?

```bash
docker inspect --format='{{.State.Health.Status}}' aip-postgres aip-redis
```

- **Either is not `healthy`** → this is a dependency problem, not the service's fault. Go to [recovery.md › Datastore down](recovery.md#a-datastore-is-down).
- **Both `healthy`** → continue.

### → What does the stuck service's log say?

```bash
docker compose logs --tail=50 <service>      # e.g. event-pipeline
```

| What you see                                       | Meaning                                  | Action                                                                                    |
| -------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `fatal startup error` then exit                    | Couldn't reach a hard dependency at boot | Confirm the dep is `healthy` (above), then `docker compose restart <service>`             |
| `consumers disabled via CONSUMERS_DISABLED`        | Booted HTTP-only on purpose              | If unintended, unset `CONSUMERS_DISABLED` and restart                                     |
| Repeated ioredis `reconnect` / `ECONNREFUSED 6379` | Redis not reachable yet                  | Wait for `aip-redis` healthy; ioredis recovers on its own (100ms→5s backoff, 20 attempts) |
| Postgres `SELECT 1` / connection errors            | DB not reachable or schema missing       | Confirm `aip-postgres` healthy; if "relation does not exist", run `pnpm db:migrate`       |
| Nothing obviously wrong, still 503                 | `/ready` dependency check failing        | `curl -s localhost:<port>/ready` — the JSON body names the failing dep + latency          |

### → Still 503 after the dependency is healthy?

```bash
docker compose restart <service>
sleep 5 && curl -s localhost:<port>/ready
```

- **Now 200** → done.
- **Still 503** → recreate it fresh (clears a wedged process / stale connection):

```bash
docker compose up -d --force-recreate <service>
```

- **Still 503** → escalate to [troubleshooting.md › A service is unhealthy](troubleshooting.md#a-service-is-unhealthy-503-or-crash-looping).

## Partial start (some services up, others not)

This is expected mid-boot — services hold at 503 until their dependencies pass healthchecks (see [FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) mode 11). Only investigate if a service is _still_ not ready ~60s after Postgres + Redis are healthy; then use the per-service tree above.

## Clean teardown

```bash
docker compose down       # stop, keep volumes (data survives)
docker compose down -v     # stop + wipe volumes (next start needs migrate + seed again)
```
