# ADR 0001: Redis pub/sub for demo event transport (deferring Kafka to production evolution)

- **Status**: Accepted
- **Date**: 2026-05-27
- **Owner**: 01 — Principal Architect
- **Reviewers**: 02 — Backend, 10 — SRE

## Context

The platform needs event transport between services for telemetry frames, AI detections, incident lifecycle changes, audit events, and WebSocket fanout. The platform is a portfolio demo built to run on a single laptop via `docker compose up`. Reviewer time is the scarce resource; demo simplicity is itself an engineering signal.

Choices considered:

- **Redis pub/sub + Redis streams** — already in our stack for caching; lightweight; well-known APIs.
- **Apache Kafka** — industry-standard for high-throughput event streaming; durable; partitioned ordering.
- **NATS** — modern alternative; lighter than Kafka, heavier than Redis.
- **RabbitMQ** — traditional broker; AMQP semantics.

## Decision

Use **Redis pub/sub** for fire-and-forget broadcast and **Redis streams** (`XADD` / `XREAD` consumer groups) for replay and ordered consumption. Kafka is documented as the production evolution target but is not introduced for the demo.

## Alternatives considered

- **Kafka**: rejected for the demo. Adds substantial infra (Zookeeper or KRaft, partitions, retention tuning) for value that doesn't show up in a 5-minute walkthrough.
- **NATS**: viable but doesn't share infra with the cache layer; adds another moving piece.
- **RabbitMQ**: heavier than Redis for what we need; AMQP semantics overkill for a streaming-first workload.

## Trade-offs

- **Lost**: durable partitioned ordering at scale, multi-week retention, high-throughput log compaction.
- **Kept**: dead-simple operational story, one process to run, fits in the cache footprint.

## Consequences

- All inter-service events use Redis channels with a consistent naming convention (`<domain>.<entity>.<action>`).
- Replay relies on Redis streams rather than Kafka log compaction.
- Idempotency is owned by **consumers** (idempotency keys + dedup), not by the transport — this code is identical whether the transport is Redis or Kafka, which makes future migration cheap.
- Backpressure is managed at the consumer (max concurrency + drop policy), not via partition pause.
- All service-to-service event contracts live in `@aip/shared-contracts/events` to keep producer/consumer in lockstep.

## Production evolution path

For a real airport deployment:

1. Introduce Kafka as the durable event log; Redis stays for ephemeral pub/sub fanout to in-tier consumers (WS broadcaster).
2. Partition events by `airport_id` for per-airport ordering guarantees.
3. Add a Kafka → Postgres CDC pipeline for analytical and audit queries.
4. Use Kafka log compaction for long-lived event-sourced state where appropriate (e.g. incident lifecycle).
5. Keep the application-layer idempotency code — it works against either transport.
6. Add schema registry (Confluent or Apicurio) for cross-team event evolution.
