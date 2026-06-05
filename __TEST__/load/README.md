# Load + resilience test suite (T-513)

On-demand load and fault-injection scenarios that drive the **live `docker-compose` stack** and assert SRE pass/fail thresholds by scraping each service's `/metrics`. This suite is **not** part of per-PR CI — it needs the full stack up and takes minutes. With no stack reachable it **skips cleanly** (it never fails a checkout or an accidental run).

Package: `@aip/load-tests` · Runner: Vitest · Entry: `pnpm test:load`

## What it proves

| #   | Scenario                     | Fault lever                         | Property asserted                                                                                           |
| --- | ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 01  | High-frequency ingestion     | —                                   | Pipeline consumes ≥99% of a sustained 200 frames/s stream, drops none                                       |
| 02  | WebSocket fanout             | —                                   | All N clients connect; ≥95% of a broadcast burst reaches every client                                       |
| 03  | Queue backlog under overload | 5 000 frames/s burst                | **Bounded shedding** (`consumer_dropped` rises) — stays alive + keeps processing, no crash/unbounded growth |
| 04  | Redis outage + recovery      | `docker stop/start aip-redis`       | Services survive the broker outage; ingestion resumes after Redis returns                                   |
| 05  | DB latency spike             | `docker pause/unpause aip-postgres` | HTTP surfaces stay live during the freeze; ingestion recovers after                                         |
| 06  | AI service outage            | `docker stop aip-ai-inference`      | **Failure isolation** — sensor ingestion unaffected while AI is down                                        |
| 07  | Replay after restart         | `docker restart aip-event-pipeline` | Pipeline resumes processing new frames with no manual intervention                                          |

Scenarios 04–07 require the **docker CLI**; if it's unavailable they self-skip rather than fail.

## How the load enters the system

There is **no HTTP ingestion endpoint** — telemetry is a Redis publish:

```
load harness ──publish──▶ Redis "sensor.frame.captured"
                              │
                              ▼
                        event-pipeline (dedup → prioritize → persist → outbox)
                              │ publish
                              ▼
                  Redis "events.broadcast.<airport>" ──▶ ws-broadcaster ──▶ WS clients
```

Frames are built to satisfy `@aip/shared-contracts` `SensorFrameEvent` and validated in-process before publish, so a contract drift fails the harness rather than being silently dropped by the consumer. WS fanout (scenario 02) publishes directly to the broadcast channel to isolate the ws-broadcaster fan-out path.

## Prerequisites

```bash
# 1. From the repo root — bring the full stack up
docker compose up -d

# 2. Wait for the edge to report healthy (transitively gates web + api-gateway + ws-broadcaster)
until docker inspect --format='{{.State.Health.Status}}' aip-nginx 2>/dev/null | grep -q healthy; do sleep 3; done

# 3. Migrate + seed (airports/sensors the scenarios reference)
pnpm db:migrate && pnpm db:seed
```

The harness defaults assume the published ports in `docker-compose.yml` (Redis `6379`, nginx edge `3000`, service `/metrics` on `3001–3008`). Every value is env-overridable — see [`src/harness/env.ts`](src/harness/env.ts) (`LOAD_*` vars) to point at a remote host or a non-default mapping.

> **Auth:** WS connections are signed with `LOAD_JWT_SECRET` / `LOAD_JWT_ISSUER`, which **must match the running stack's** `JWT_SECRET` / issuer or every upgrade closes with `4401`. The default matches the compose CI secret.

## Running

```bash
# All seven scenarios (from repo root)
pnpm test:load

# Or directly in the package
pnpm --filter @aip/load-tests test:load

# A single scenario
pnpm --filter @aip/load-tests exec vitest run scenarios/04-redis-outage.scenario.ts
```

Scenarios run **sequentially in a single fork** — they mutate one shared stack (publishing load, stopping containers), so they must not overlap.

Tear down when done:

```bash
docker compose down -v
```

## Thresholds

All pass/fail numbers live in one place — [`src/harness/thresholds.ts`](src/harness/thresholds.ts) — so they're auditable and tunable without touching scenario logic. They are **demo-scale** targets for a single-host compose stack, not a tuned cluster:

| Scenario        | Key thresholds                                                          |
| --------------- | ----------------------------------------------------------------------- |
| 01 ingestion    | 2 000 frames @ 200/s · ≥99% processed · 0 dropped                       |
| 02 WS fanout    | 50 clients · 20 frames · ≥95% delivered to every client · all connected |
| 03 backlog      | 20 000 frames @ 5 000/s · stays live + makes progress (drops expected)  |
| 04 redis outage | recover ≤20 s · ≥95% of post-recovery batch processed                   |
| 05 db latency   | 4 s freeze · live throughout · ≥95% post-unfreeze processed             |
| 06 ai outage    | 500 frames during outage · ≥99% processed (isolation)                   |
| 07 replay       | restart · resume ≤30 s · ≥95% of post-restart batch processed           |

**Retuning for a real deployment:** raise `targetRatePerSec`/`totalFrames` to your expected peak, tighten `recoverWithinMs` to your SLO, and add p95-latency assertions via `histogramQuantile(samples, "http_request_duration_seconds", 0.95, …)` (the helper is already in [`src/harness/metrics.ts`](src/harness/metrics.ts)).

## Metrics read by the assertions

- **RED triple** (every service, prefix `http`): `http_requests_total{method,route,status}`, `http_errors_total{…}`, `http_request_duration_seconds` (histogram).
- **Consumer queues** (event-pipeline, prefix `consumer`): `consumer_processed_total{queue="sensor-frames"}`, `consumer_depth{…}`, `consumer_dropped_total{…}` (backpressure shedding), `consumer_errors_total{…}`.

`processed_total` is **per-process** and resets on restart — scenario 07 accounts for this by re-baselining after the pipeline comes back.

## Layout

```
__TEST__/load/
├── package.json            # @aip/load-tests workspace package
├── vitest.config.ts        # isolated runner (sequential, long timeouts)
├── src/harness/
│   ├── env.ts              # ports/hosts/channels/airports — all LOAD_* overridable
│   ├── stack.ts            # reachability probe → clean skip when stack down
│   ├── auth.ts             # mints stack-valid operator tokens
│   ├── redis-load.ts       # frame builder + rate driver (driveAtRate)
│   ├── ws-fanout.ts        # open N WS clients, count fanout
│   ├── metrics.ts          # Prometheus text parser + p95/error-rate helpers
│   ├── docker.ts           # stop/start/pause/restart fault lever (+ withFault)
│   ├── thresholds.ts       # all SRE pass/fail numbers
│   └── support.ts          # poller + consumer-counter convenience reads
└── scenarios/
    ├── 01-high-frequency-ingestion.scenario.ts
    ├── 02-websocket-fanout.scenario.ts
    ├── 03-queue-backlog.scenario.ts
    ├── 04-redis-outage.scenario.ts
    ├── 05-db-latency.scenario.ts
    ├── 06-ai-timeout.scenario.ts
    └── 07-replay-after-restart.scenario.ts
```

## Notes & limitations

- **No production code is modified.** Faults are injected at the container boundary (docker), not via in-service chaos hooks — adding latency/timeout env switches to services would be its own change, not a load-test concern.
- **Scenario 06** asserts _failure isolation_ rather than a per-request AI timeout value: `ai-inference` is a stub in this phase and is not on the sensor-ingestion hot path, so the real, meaningful property is that its outage stays contained.
- **Scenario 03** intentionally has no upper bound on drops — "bounded vs. unbounded" is proven by _still alive + still processing_ after the storm; drops are the graceful-degradation signal, not a failure.
