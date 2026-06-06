# Demo rescue pack

The contingency layer for the [demo walkthrough](DEMO_WALKTHROUGH.md). The walkthrough is the script when everything works; this is what you reach for when it doesn't. **A demo that recovers gracefully from a glitch is more impressive than one that never glitches** — narrate the failure as a feature ("watch it recover"), don't apologize for it.

## Pre-flight checklist (run T-minus 15 minutes)

```bash
# 1. Clean slate + bring up
docker compose down -v && docker compose up -d
until docker inspect --format='{{.State.Health.Status}}' aip-nginx 2>/dev/null | grep -q healthy; do sleep 3; done
pnpm db:migrate && pnpm db:seed

# 2. Every service ready?
for p in 3001 3003 3004 3005 3006 3007 3008; do
  printf "%s " $p; curl -s -o /dev/null -w "%{http_code}\n" localhost:$p/ready; done
#   → all 200. Any 503 → docs/runbooks/startup.md before the demo, not during.

# 3. Dashboard loads + login works
open http://localhost:3000          # log in as pat.operator@airport-ops.test
```

Confirm before you present:

- [ ] All `/ready` return 200; `docker compose ps` shows every service `Up`.
- [ ] Dashboard loads, login works for **operator** and **reviewer** accounts.
- [ ] Each of the 3 spine beats fires once (FOD, sensor outage, weather LOW CONF) — see them work in rehearsal so they're not a surprise.
- [ ] A second terminal is ready with the fault-injection commands below pre-typed.
- [ ] The rescue assets (screenshots / recorded clip) are open in background tabs.
- [ ] Browser zoom set for readability; notifications silenced.

## The spine: lead with what CI proves

Three beats are proven end-to-end by the dockerized e2e suite — **build the demo on these**, treat scenarios 2/3/5 as bonus:

| Beat                     | Scenario                  | CI proof                                                           |
| ------------------------ | ------------------------- | ------------------------------------------------------------------ |
| FOD full workflow        | `01-fod-runway`           | [e2e 07](../__TEST__/e2e/scenarios/07-fod-runway-workflow.spec.ts) |
| Sensor outage + recovery | `04-sensor-outage-replay` | [e2e 04](../__TEST__/e2e/scenarios/04-sensor-outage.spec.ts)       |
| Weather LOW CONF → HITL  | `06-weather-degraded`     | [e2e 06](../__TEST__/e2e/scenarios/06-weather-degraded.spec.ts)    |

If you have to cut for time, these three in this order tell the whole story (workflow → resilience → safety).

## Per-beat fallback

### Beat 1 — FOD workflow doesn't trigger / no alert appears

1. Re-fire the scenario once (it's idempotent — dedup suppresses a true repeat, so a second trigger is safe).
2. Still nothing? Check the pipeline is consuming: `curl -s localhost:3004/metrics | grep '^consumer_processed_total'` — climbing means events flow; the gap is the browser. Reload the dashboard (the WS client reconnects with a resume cursor).
3. Hard fallback: switch to the **FOD screenshot** and narrate the workflow + audit lineage from it. The talking points below stand on their own.

### Beat 2 — Redis/outage beat misbehaves

This beat _is_ a fault injection, so "it broke" is on-message. If the manual `docker compose stop redis` doesn't visibly change the dashboard, say: _"The services stay up through this by design — the gateway's rate limiter fails open, so the REST surface never noticed."_ Then `docker compose start redis` and show `consumer_processed_total` resuming. If the dashboard is wedged after recovery, reload — that demonstrates the reconnect-resume path, which is the point.

### Beat 3 — Weather LOW CONF doesn't surface

1. Re-fire `06-weather-degraded`.
2. If the LOW CONF indicator doesn't render, pivot to the **explanation**: pull up [ADR 0009](adr/0009-hitl-routing-thresholds.md) and walk the weighted risk score (confidence*gap / severity / freshness / prior-failure → 0.6 HITL, 0.95 exception). The \_reasoning* is the impressive part, not the pixel.

### Login / auth fails mid-demo

Token TTL is 15 min — if you've been talking a while, re-login. A `4401` on the WS or a `401` on REST both mean "re-auth." See [troubleshooting › auth](runbooks/troubleshooting.md#auth-failures-401--403).

## Total-failure plan: the demo runs without a running demo

If the stack won't come up at all, **pivot to the engineering story** — it's arguably the stronger pitch for a senior role anyway:

1. **Architecture** — the [README diagram](../README.md#architecture): edge/cloud split, the Redis seam, the single api-gateway surface.
2. **The interesting code** — walk the [PR review guide](PR_REVIEW_GUIDE.md) spine: the event pipeline (dedup/watermark/outbox), the three-different-right-answers degradation, the audit hash chain.
3. **Proof it's real** — the [failure-mode matrix](FAILURE_MODE_MATRIX.md) (11 modes traced to code), the [security](../__TEST__/security/) + [load](../__TEST__/load/) suites, and the **green CI** (lint/typecheck/unit + e2e mocked **and** dockerized + Trivy security scan). "I can't show you the running app right now, but here's the test tier that runs it on every commit and the two production bugs the dockerized tier caught."

A recorded screen-capture of a successful run, kept in a background tab, is the cleanest total-failure rescue — record one during a green rehearsal.

## Canned talking points (work without a live screen)

- **"Why is this senior-level?"** — _The decisions aren't which-framework; they're where to put a boundary, what to do when a dependency dies, and how to make an automated safety call auditable. The ADRs and failure matrix are the evidence._
- **"What happens when Redis dies?"** — _Uneven by blast radius: the rate limiter fails open, a missed audit row is logged-not-thrown, but an incident transition that can't be announced fails the request. Three different right answers — [matrix mode 5](FAILURE_MODE_MATRIX.md)._
- **"How do you know it's resilient?"** — _I don't assert it, I test it: the load suite stops Redis, pauses Postgres, restarts the pipeline, and asserts recovery each time._
- **"Is the AI real?"** — _No — deterministic seeded heuristics with calibrated confidence. The point is the validation + HITL system around inference, which is what production engineering actually owns. [ADR 0004](adr/0004-ai-inference-simulation.md)._
- **"What would you change for production?"** — _Kafka for a durable partitioned log, a real model server, distributed watermark/breaker state, server-side WS hydration. Every one is written up as a production-evolution path, not discovered live._

## Recovery cheat-sheet

| Symptom            | One move                                                              |
| ------------------ | --------------------------------------------------------------------- |
| A service 503      | `docker compose restart <service>` → re-check `/ready`                |
| Live feed frozen   | reload dashboard (WS reconnects); else `docker compose restart redis` |
| Whole stack wedged | `docker compose down && docker compose up -d` (volumes kept)          |
| Anything else      | [runbooks/troubleshooting.md](runbooks/troubleshooting.md)            |

> **Reminder for the maintainer:** the visual polish items in T-515 (alert animations, evidence-card transitions, timeline scrubber feel) and a timed full dry-run of all 6 scenarios need a live app session — they're not capturable in a doc. This rescue pack covers the "rescue plan documented" acceptance criterion; pair it with one rehearsed, recorded dry-run.
