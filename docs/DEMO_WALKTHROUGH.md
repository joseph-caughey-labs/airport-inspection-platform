# Demo walkthrough

A scripted ~5-minute presentation of the platform. Timings are targets for a dry-run; the **bold lines** are what to say, the rest is what to do and what to click. Practice once against a live stack so the beats land.

**Before you start:** stack up + seeded + healthy, dashboard open and logged in as `pat.operator@airport-ops.test` in one tab, a terminal ready in another. See [runbooks/startup.md](runbooks/startup.md). If a live beat misfires, fall back to the talking points — the architecture story stands on its own.

---

## 0:00 — Opening pitch (30s)

> "This is an AI-assisted airport inspection platform. Cameras and sensors watch the airfield, a computer-vision service flags hazards — foreign object debris on a runway, a pavement crack, a snowbank too close to a taxiway — and operators triage them in real time. I built it to look like a system that could actually run a shift: not just the happy path, but the observability, security, failure handling, and tests a real deployment needs. It's 13 services; I'll show you it working, then the engineering underneath."

## 0:30 — Architecture in one breath (45s)

Show the diagram (README or a second monitor).

> "Sensors and the AI service live at the **edge** — near the cameras, because you can't stream raw video to the cloud on every frame. They publish onto Redis. The **cloud** side consumes: an event pipeline that dedups, orders, and persists; a 10-layer validation engine that scores each detection; an incident service for the lifecycle; and a hash-chained audit log. Everything the browser touches goes through **one** api-gateway — one auth point, one rate limit, one error shape. The dashboard updates over WebSockets."

> "The seam between edge and cloud is just Redis channels — so in production you'd split them across a WAN without rewriting anything. That's [ADR 0007](adr/0007-edge-cloud-separation.md)."

## 1:15 — Live demo (2:45 total)

### Beat 1 — FOD on a runway: the full workflow (1:00)

Trigger scenario 1 (FOD). Scenarios are seeded simulation contracts under [`data/scenarios/`](../data/scenarios/); the FOD beat is the one proven end-to-end by [`07-fod-runway-workflow.spec.ts`](../__TEST__/e2e/scenarios/07-fod-runway-workflow.spec.ts).

> "A camera on runway 10L just flagged foreign object debris. Watch the dashboard."

- A **critical** alert appears on the live feed.
- Open it → an incident with severity, the detection's confidence, and an evidence card.
- **Acknowledge → assign → resolve.**

> "Each of those transitions is a real REST call through the gateway, RBAC-checked, and — this is the part I care about — each one lands on a **tamper-evident audit chain**. The incident timeline you're seeing is built from that chain."

Show the timeline / audit lineage.

> "That audit log is a SHA-256 hash chain with a verify endpoint. You can't quietly edit history — [ADR 0010](adr/0010-audit-immutability.md)."

### Beat 2 — Sensor outage: resilience you can see (0:55)

Trigger scenario 4 (sensor outage), or stop the broker: `docker compose stop redis` then `start redis`. Proven by [`04-sensor-outage.spec.ts`](../__TEST__/e2e/scenarios/04-sensor-outage.spec.ts).

> "Real airfields lose sensors and links. Let me kill the event broker mid-stream."

- The dashboard connection chip flips to **stale/reconnecting** — but the UI stays usable, not blank.
- Bring it back.

> "The browser reconnects on its own with a resume cursor, and the services never died — the gateway stayed up because its rate limiter fails _open_ on a Redis flap. Nothing was lost: events accepted before the outage are durable in an outbox table and resend on recovery. I don't just claim that — there's a [load + resilience suite](../__TEST__/load/) that stops Redis, pauses Postgres, and restarts the pipeline, asserting recovery each time."

### Beat 3 — Weather degrades the AI → human-in-the-loop (0:50)

Trigger scenario 6 (weather-degraded). Proven by [`06-weather-degraded.spec.ts`](../__TEST__/e2e/scenarios/06-weather-degraded.spec.ts).

> "Now visibility drops. The AI's confidence degrades — and a low-confidence detection of a _critical_ hazard is exactly when you want a human."

- A detection surfaces with a **LOW CONF** indicator and routes to the reviewer queue.
- (Optional) switch to `rio.reviewer@airport-ops.test` and adjudicate.

> "That routing isn't a single confidence cutoff — it's a weighted risk score over confidence, severity, freshness, and how much earlier validation struggled, with the _reason_ attached so it's auditable. [ADR 0009](adr/0009-hitl-routing-thresholds.md). Automating a safety call you can't explain is worse than not automating it."

## 4:00 — Engineering + testing talking points (40s)

> "Under all of that: every service emits correlated structured logs and the same RED metrics; every protected route verifies a JWT and checks role permissions locally — it never trusts the gateway hop; and I wrote down how all 11 failure modes are detected and recovered in a [failure-mode matrix](FAILURE_MODE_MATRIX.md), each row traced to the actual code."

> "Testing is layered: unit, API, integration, end-to-end — and the e2e runs **twice**, once mocked for speed and once against the real dockerized stack to catch wire-level bugs. Plus a security suite (token forgery, RBAC boundaries, injection) and the load suite. The dockerized tier already caught two real production-wiring bugs the mocked tier couldn't."

## 4:40 — Production readiness + close (20s)

> "I was honest about the demo trade-offs — Redis instead of Kafka, a simulated model, hand-tuned thresholds — and every one has a documented production-evolution path. The boundaries are drawn so the simulated parts swap out without touching their neighbours."

> "So: a working AI inspection demo, and underneath it the observability, security, resilience, and tests that show I build for the shift after the demo. Happy to go deep on any piece."

---

## Scenario trigger reference

| #   | Scenario               | File                                                                               | Proven by                                                          |
| --- | ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | FOD on runway          | [`01-fod-runway.json`](../data/scenarios/01-fod-runway.json)                       | [e2e 07](../__TEST__/e2e/scenarios/07-fod-runway-workflow.spec.ts) |
| 2   | Snowbank violation     | [`02-snowbank-violation.json`](../data/scenarios/02-snowbank-violation.json)       | seeded contract                                                    |
| 3   | Pavement crack         | [`03-pavement-crack.json`](../data/scenarios/03-pavement-crack.json)               | seeded contract                                                    |
| 4   | Sensor outage + replay | [`04-sensor-outage-replay.json`](../data/scenarios/04-sensor-outage-replay.json)   | [e2e 04](../__TEST__/e2e/scenarios/04-sensor-outage.spec.ts)       |
| 5   | Duplicate suppression  | [`05-duplicate-suppression.json`](../data/scenarios/05-duplicate-suppression.json) | seeded contract                                                    |
| 6   | Weather-degraded       | [`06-weather-degraded.json`](../data/scenarios/06-weather-degraded.json)           | [e2e 06](../__TEST__/e2e/scenarios/06-weather-degraded.spec.ts)    |

## If a live beat misfires

The three CI-proven beats (1, 4, 6) are the safe spine — lead with those. The full contingency layer — pre-flight checklist, per-beat fallbacks, a total-failure plan, and canned talking points that work without a live screen — is the **[demo rescue pack](DEMO_RESCUE.md)**. Rehearse with it once; the [troubleshooting runbook](runbooks/troubleshooting.md) is the fast path for a mid-demo hiccup.
