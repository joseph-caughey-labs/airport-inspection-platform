# Architecture Decision Records (ADRs)

This folder captures the **why** behind every significant architectural choice in the Airport Inspection Platform. Code answers _what_ the system does; ADRs answer _why_ it does it that way.

## When to write an ADR

Write an ADR when you make a decision that:

- Affects more than one service, or
- Constrains future engineering (e.g., picks a database, transport, or framework), or
- Has alternatives that someone might reasonably propose later, or
- Trades one capability away to gain another.

Skip an ADR for routine implementation decisions inside a single module.

## Format

Use [`_template.md`](_template.md). Every ADR has:

- **Context** — the forces and constraints that motivated the decision.
- **Decision** — what was decided.
- **Alternatives considered** — what was rejected and why.
- **Trade-offs** — what was given up.
- **Consequences** — what follows from the decision.
- **Production evolution path** — how the decision would change at real-airport scale.

## Numbering

Sequential. Never reuse a number, even for superseded ADRs. Status field handles state transitions.

## Index

| #                                          | Title                                                 | Status              | Owner               |
| ------------------------------------------ | ----------------------------------------------------- | ------------------- | ------------------- |
| [0001](0001-redis-pubsub-vs-kafka.md)      | Redis pub/sub for demo event transport                | Accepted            | Principal Architect |
| [0002](0002-websockets-for-realtime.md)    | WebSockets for real-time operator updates             | Accepted            | Principal Architect |
| [0003](0003-service-boundary-rationale.md) | Service boundary rationale (10 services + 1 frontend) | Accepted            | Principal Architect |
| 0004                                       | AI inference simulation strategy                      | _Draft (T-301)_     | AI/ML Engineer      |
| [0005](0005-idempotency-and-retries.md)    | Idempotency, retries, and circuit breakers            | Accepted            | SRE                 |
| 0006                                       | Event ordering and deduplication                      | _Draft (T-206)_     | Backend             |
| 0007                                       | Edge / cloud separation                               | _Pending (Phase 5)_ | Principal Architect |
| [0008](0008-parity-10-layer-validation.md) | Parity 10-layer validation pipeline                   | Accepted            | Validation Engineer |
| 0009                                       | HITL routing thresholds                               | _Draft (T-409)_     | Validation Engineer |
| [0010](0010-audit-immutability.md)         | Audit immutability                                    | Accepted            | Database            |
| [0011](0011-input-validation-and-auth.md)  | Input validation, JWT auth, and RBAC                  | Accepted            | Security            |
| 0012                                       | Branching and release strategy                        | _Pending_           | Project Manager     |

Status values: **Proposed**, **Accepted**, **Superseded by ADR-NNNN**, **Deprecated**.
