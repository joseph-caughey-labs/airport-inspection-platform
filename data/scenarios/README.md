# Demo scenarios

Each scenario is a self-contained trigger that exercises a specific demo beat. The orchestration layer that consumes these files lives in **T-201** (sensor-gateway simulators) and **T-209** (event-pipeline replay/scenario hooks). Until those land, scenarios are static contracts only — they describe **what** each demo beat looks like, not yet **how** it's triggered.

| #   | File                                                             | Demonstrates                                                                                   | Lands end-to-end |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| 01  | [`01-fod-runway.json`](01-fod-runway.json)                       | FOD on an active runway → critical severity → full ack/assign/resolve workflow → audit lineage | T-416            |
| 02  | [`02-snowbank-violation.json`](02-snowbank-violation.json)       | Snowbank height + setback violation routed to maintenance                                      | T-499            |
| 03  | [`03-pavement-crack.json`](03-pavement-crack.json)               | Crack classification + severity-band mapping                                                   | T-499            |
| 04  | [`04-sensor-outage-replay.json`](04-sensor-outage-replay.json)   | Sensor offline → reconnect → event replay                                                      | T-214            |
| 05  | [`05-duplicate-suppression.json`](05-duplicate-suppression.json) | Two cameras emit the same FOD; dedup suppresses one                                            | T-214            |
| 06  | [`06-weather-degraded.json`](06-weather-degraded.json)           | Visibility drops → AI confidence degraded indicator surfaces                                   | T-311            |

## Scenario shape

Every scenario follows the same envelope:

```json
{
  "id": "01-fod-runway",
  "title": "FOD detected on active runway",
  "description": "...",
  "airport_icao": "KSFO",
  "trigger": { ... shape varies by scenario ... },
  "expected": {
    "severity": "critical",
    "validation": {
      "certified": true,
      "hitl_required": false
    },
    "incident_status_after_ack": "acknowledged",
    "audit_events_at_least": ["sensor.frame.captured", "ai.detection.emitted", "incident.created"]
  }
}
```

The `expected` block is what e2e tests assert against. Trigger shapes are loose now — Phase 2 fleshes them out with concrete sensor frame schemas.

## Domain realism notes (per Domain Expert role)

- Runway designators use the real SFO and JFK layouts (`10L/28R`, `10R/28L`, `04L/22R`, `04R/22L`).
- Sensor ids follow `TYPE-LOCATION-INDEX` convention (`CAM-RWY10L-01`, `WX-TOWER-01`).
- SOP thresholds in `expected` mirror `data/seed/reference/sop-baseline.json`.
- Severity bands match the airport-ops vocabulary (critical = runway closure possible).
