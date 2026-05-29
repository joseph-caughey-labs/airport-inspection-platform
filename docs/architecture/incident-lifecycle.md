# Incident Lifecycle

The incident-service owns the state machine that operators (and the validation engine) walk every incident through. This document describes the legal transitions, the side branches, and the audit / notification consequences.

## States

| State          | Active?  | Set by                                                                                 |
| -------------- | -------- | -------------------------------------------------------------------------------------- |
| `new`          | yes      | Detection bridge (T-310) when an AI detection clears all confidence + smoothing gates. |
| `acknowledged` | yes      | An operator has confirmed the incident is real.                                        |
| `assigned`     | yes      | An operator (or assignment policy in T-404) has routed it to a responder.              |
| `in_progress`  | yes      | Responder is working the incident.                                                     |
| `escalated`    | yes      | Severity, time-in-state, or operator action raised it to the supervisor queue.         |
| `resolved`     | yes      | Responder marked the incident closed.                                                  |
| `archived`     | terminal | Removed from the operator queue after resolution; preserved for audit.                 |
| `rejected`     | terminal | The validation engine (T-405) or an operator flagged this as a false positive.         |

## Transition graph

```
                    ┌─────────────┐
                    │     new     │
                    └──────┬──────┘
            acknowledge    │    reject ──────► rejected
                           ▼
                    ┌─────────────┐
                    │acknowledged │
                    └──────┬──────┘
            assign         │    reject ──────► rejected
                           ▼
                    ┌─────────────┐
                    │  assigned   │
                    └──────┬──────┘
            start_progress │    reject ──────► rejected
                           ▼
                    ┌─────────────┐
                    │ in_progress │
                    └──────┬──────┘
            resolve        │    reject ──────► rejected
                           ▼
                    ┌─────────────┐
                    │  resolved   │
                    └──────┬──────┘
                  archive  │
                           ▼
                    ┌─────────────┐
                    │  archived   │ (terminal)
                    └─────────────┘

  escalate (from any active state):  ─────────► escalated
  From escalated:
      acknowledge  → assigned       (re-route to a new responder)
      resolve      → resolved       (handled in flight)
      reject       → rejected       (false alarm)
```

`archived` and `rejected` are **terminal** — no transitions out. The `Incident.dispatch()` call raises `TerminalStateError` if a command targets a terminal state.

## Commands (the verbs the API exposes)

| Command          | Required from              | Produces                                                           | Notes                                                                                            |
| ---------------- | -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `acknowledge`    | `new`, `escalated`         | `acknowledged` (from new) or `assigned` (from escalated, re-route) | The dual-target on `escalated` lets a supervisor re-assign without going back to `acknowledged`. |
| `assign`         | `acknowledged`             | `assigned`                                                         | T-404 may invoke this on the operator's behalf.                                                  |
| `start_progress` | `assigned`                 | `in_progress`                                                      | Responder marks active work.                                                                     |
| `resolve`        | `in_progress`, `escalated` | `resolved`                                                         | Resolution summary required (`reason`).                                                          |
| `escalate`       | any active state           | `escalated`                                                        | Side-branch entry. Severity overrides + SLA timers (T-404) auto-fire this.                       |
| `archive`        | `resolved`                 | `archived`                                                         | Removes from operator queue.                                                                     |
| `reject`         | any non-terminal           | `rejected`                                                         | Validation engine drives most of these.                                                          |

## Error contracts

Two typed errors are thrown by the state machine:

- **`IllegalTransitionError`** — the command isn't legal from the current state. Maps to **HTTP 409 Conflict** in the T-402 REST API.
- **`TerminalStateError`** — the incident is already archived or rejected. Maps to **HTTP 410 Gone**.

Both carry `code` (`ILLEGAL_TRANSITION`, `TERMINAL_STATE`) so the HTTP layer doesn't need to instanceof-check.

## Live transition endpoints

| Endpoint                             | Command          | Ticket | Status                                            |
| ------------------------------------ | ---------------- | ------ | ------------------------------------------------- |
| `POST /incidents/:id/acknowledge`    | `acknowledge`    | T-403  | **live** — operator UI calls it via `IncidentApi` |
| `POST /incidents/:id/assign`         | `assign`         | T-404  | planned                                           |
| `POST /incidents/:id/start_progress` | `start_progress` | T-404  | planned                                           |
| `POST /incidents/:id/resolve`        | `resolve`        | T-404  | planned                                           |
| `POST /incidents/:id/escalate`       | `escalate`       | T-404  | planned                                           |
| `POST /incidents/:id/archive`        | `archive`        | T-404  | planned                                           |
| `POST /incidents/:id/reject`         | `reject`         | T-404  | planned                                           |

### `POST /incidents/:id/acknowledge` (T-403)

Body: `AcknowledgeIncidentRequest` = `{ operator_id: uuid, note?: string }`.

On success the route:

1. `Incident.dispatch({ command: "acknowledge", actor: operator_id, reason: note })` — pure state-machine call, throws `IllegalTransitionError` / `TerminalStateError` on bad input.
2. Persists the next aggregate via `IncidentRepository.save()` with `acknowledged_by` and `acknowledged_at` denormalized onto the envelope so the operator UI can render the actor without joining the history.
3. Publishes the `IncidentTransitionedEvent` via `IncidentEventPublisher.emit()` on the `incident.transition.acknowledged` channel. The `note` is threaded into `transition.reason` for the audit trail.

**Publish failure is decoupled from persistence.** If Redis is offline the persisted transition stands and the route still returns 200 — at-least-once delivery to audit/notification consumers comes from the outbox in a later ticket, not from rolling back the operator's action. This was an explicit decision: a flap on the message bus should never block an operator from acknowledging an active runway incident.

Error mapping:

| HTTP | Error code           | Trigger                                                |
| ---- | -------------------- | ------------------------------------------------------ |
| 400  | `INVALID_ID`         | Path `:id` is not a UUID.                              |
| 400  | `VALIDATION`         | Body fails the `AcknowledgeIncidentRequest` zod parse. |
| 404  | `INCIDENT_NOT_FOUND` | Repository returned `null` for `:id`.                  |
| 409  | `ILLEGAL_TRANSITION` | Incident is past `new` (e.g. already acknowledged).    |
| 410  | `TERMINAL_STATE`     | Incident is `archived` or `rejected`.                  |

## Domain events

Every successful `dispatch()` produces an `IncidentTransitionedEvent` and surfaces it on the Redis channel `incident.transition.<next_state>`. Two consumers in Phase 4:

- **audit-service** (T-412) persists each event to the append-only `audit_events` table with a hash-chained signature.
- **notification-service** (T-413) routes to operator channels (in-app, webhook, email-stub).

The channel suffix (`<next_state>`) lets notification rules subscribe only to the events they care about — e.g. only `incident.transition.escalated` and `incident.transition.resolved`.

The event envelope is built by `domain/events.ts::buildTransitionEvent`. The actual Redis publish stays in the service write path (T-402) so the domain layer remains I/O-free and trivially unit-testable.

## Audit trail invariant

The `Incident` aggregate carries an immutable `history: readonly Transition[]` field that's appended on every `dispatch()`. Combined with the audit-service hash chain (T-412), the lifecycle of every incident is reconstructible from disk without consulting Redis. The history is the source of truth for "who did what when" in postmortems.

## Domain Expert review

State names and consequences reviewed per `__PLANNING__/ROLES/13_domain-expert.md`. Notable calls:

- **`escalated` is a state, not a flag.** The supervisor queue and the SLA timers both pivot on this. A `priority_bumped` boolean was rejected during planning because it muddied the audit trail.
- **`archived` ≠ deleted.** Operators need to see closed incidents during audits and certifications.
- **Validation-driven `rejected`** keeps the false-positive review path separate from operator-driven dismissals; the validation engine (T-405) will be the only legitimate caller for the operator-bypass case.
