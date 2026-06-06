# ADR 0006: Event ordering and deduplication

- **Status**: Accepted
- **Date**: 2026-06-05
- **Owner**: Backend
- **Reviewers**: Principal Architect, SRE

## Context

Redis pub/sub — the platform's event transport ([ADR 0001](0001-redis-pubsub-vs-kafka.md)) — gives us neither ordering nor exactly-once delivery. Messages can arrive out of order (concurrent publishers, a reconnecting subscriber replaying), and the same logical event can arrive more than once (ioredis `pmessage` redelivery, an outbox worker resuming, an operator retry). The consumer is therefore responsible for both **ordering** and **deduplication** — the transport won't do it.

[ADR 0005](0005-idempotency-and-retries.md) sets the _policy_: every write carries an `idempotency_key`, every subscriber dedups. This ADR specifies the _mechanism_ in event-pipeline — how late and duplicate frames are actually classified and handled — because that algorithm (a watermark + a bounded replay queue) is a non-obvious design with its own failure modes worth pinning.

The governing constraint is the demo's scale: a single event-pipeline process. That makes an **in-memory** watermark + dedup window the right-sized choice, and it makes the single-process assumption the thing a future reader most needs to know about.

## Decision

Two cooperating mechanisms sit in front of the persist handler, composed outside-in as `dedup → prioritize → persist`:

### Deduplication (`services/event-pipeline/src/dedup`)

- A `DedupStore` keyed on `idempotency_key` with a TTL window (`DEDUP_WINDOW_MS`, default **5s**), lazily swept. A repeat within the window is suppressed before it reaches the handler and counted as `consumer_suppressed_total{queue}`.
- The persistence layer is the backstop: `INSERT … ON CONFLICT (idempotency_key) DO NOTHING` makes the write itself idempotent for repeats that fall outside the in-memory window.

### Ordering (`services/event-pipeline/src/prioritization`)

- A `WatermarkTracker` keeps a per-`sensor_id` high-water mark of the latest `captured_at` seen, with a tolerance (`WATERMARK_TOLERANCE_MS`, default **30s**). Each frame is classified:
  - **`in_order`** (`captured_at ≥ watermark`) → advance the mark, pass through.
  - **`late_in_window`** (behind the mark, within tolerance) → pass through, count.
  - **`late_beyond_window`** (behind by more than tolerance) → divert to the replay queue.
- A bounded `ReplayQueue` (`REPLAY_QUEUE_MAX`, default **1024**, drop-oldest on overflow) holds the late-beyond frames; a `ReplayQueueWorker` drains them on an interval straight to the persist handler, **bypassing the watermark** so a known-late frame can't loop back into the replay path.

Both structures are in-memory and per-process — a deliberate fit for the single-instance demo.

## Alternatives considered

- **Trust the transport for ordering** (i.e. assume Redis delivers in order): rejected — pub/sub gives no such guarantee across publishers or across a subscriber reconnect; "mostly ordered in practice" is not a contract to build correctness on.
- **Drop all late frames**: rejected — a brief subscriber hiccup would silently lose data; `late_in_window` frames are still useful and `late_beyond_window` ones deserve a bounded second chance, not the floor.
- **Persist-time dedup only (no in-memory window)**: rejected — correct but wasteful; it pushes every duplicate through the full pipeline to be rejected by the DB constraint, burning the work a 5s memory window cheaply avoids.
- **A durable, ordered log (Kafka) with consumer offsets**: rejected for the demo for the same reasons as ADR 0001 — operational weight far beyond a single-host portfolio piece. It is the production evolution, below.

## Trade-offs

- **Lost**: correctness under horizontal scale. The watermark and dedup window live in one process's memory, so two event-pipeline replicas would each keep their own mark and dedup independently — duplicates and ordering errors could slip between them.
- **Lost**: durability of the replay buffer. The `ReplayQueue` is in-memory; a process restart drops whatever late frames were waiting (the durable path is the DB + outbox, not the replay queue). Overflow drops the oldest with no dedicated metric (a documented gap).
- **Kept**: cheap, fast, and correct for the single-process demo — O(1) dedup checks, bounded memory, no external coordination, and a clear classification an operator can reason about from `frame_order_total{status}`.

## Consequences

- Ordering/dedup is observable: `consumer_suppressed_total`, `frame_order_total{status}`, and `replay_drained_total` tell the oncall whether an upstream is sending duplicates or out-of-order data ([FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) modes 3 and 10; recovery in [runbooks/replay.md](../runbooks/replay.md)).
- The "single-process" assumption is now explicit and must be revisited before any horizontal scale-out — it's the first thing to break.
- Load [scenario 07](../../__TEST__/load/scenarios/07-replay-after-restart.scenario.ts) exercises the restart behaviour (in-memory state lost, durable path resumes).

## Production evolution path

At real scale the in-memory structures move to shared state: a **Redis-backed watermark** (per-sensor `captured_at` in a hash, read/written by every replica) so ordering is consistent across instances, and a **durable replay queue** (a Redis stream or the `event_outbox` table) so late frames survive a restart. The natural end state is the Kafka log ADR 0001 defers — partition by `sensor_id` for per-sensor ordering, consumer offsets for at-least-once, log compaction keyed on `idempotency_key` for dedup — at which point this consumer-side machinery shrinks to "trust the partition order, dedup on key."
