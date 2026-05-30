# `audit-service`

Append-only audit log with hash-chained tamper evidence. **T-412 (this PR)** lands the hash chain INSERT path, Redis subscribers, and the query / verification HTTP surface. The append-only invariant is enforced at the DB role level by [ADR 0010](../../docs/adr/0010-audit-immutability.md); the hash chain in `src/chain/hash.ts` is the matching **detection** layer.

## Endpoints

| Method | Path                         | Returns                                                                   |
| ------ | ---------------------------- | ------------------------------------------------------------------------- |
| GET    | `/health`                    | 200 ok                                                                    |
| GET    | `/ready`                     | 200 when both Redis and Postgres are healthy                              |
| GET    | `/audit/events`              | Paginated list, newest first. `?limit=&cursor=`                           |
| GET    | `/audit/events/:event_id`    | Single envelope. 404 when not found.                                      |
| GET    | `/audit/lineage/:subject_id` | All events for a subject (e.g. incident id), oldest first.                |
| POST   | `/audit/verify`              | Recompute hashes over a range. Body: `{ from_seq?, to_seq? }`. See below. |

## Subscribers

- `incident.transition.*` — `incident-service` (T-403/T-404) publishes one per state transition. Mapped to:
  - `source = "incident-service"`
  - `event_type = "incident.transitioned"`
  - `subject_id = incident_id`
  - `actor_user_id = transition.actor` (UUID; null when system-emitted)
  - `payload = the full envelope`
  - `rationale = transition.reason`

Subscriptions land on a dedicated Redis client so the pub/sub mode doesn't interfere with the healthcheck client's `PING`. ioredis pmessage delivery is at-least-once; the chain writer's transactional INSERT collapses any duplicate replays via the canonical entry hash (a re-INSERT of the same `event_id` would violate the unique constraint and the subscriber's caller logs + counts the failure).

## Hash chain

```
entry_hash = sha256( prev_hash || canonical_json(entry minus entry_hash) )
```

Pure helpers live in `src/chain/hash.ts` so the chain semantics are deterministic and unit-testable without a DB. `canonical_json` sorts object keys lexicographically; arrays preserve order (semantic).

`AuditChainWriter.append()` runs each INSERT inside a transaction:

1. `BEGIN`
2. `SELECT pg_advisory_xact_lock(<fixed key>)` — serializes the chain tip across concurrent writers
3. `SELECT entry_hash FROM audit_events ORDER BY seq DESC LIMIT 1` — read tip
4. compute new `entry_hash`
5. `INSERT INTO audit_events (...) RETURNING ...`
6. `COMMIT`

Without the advisory lock, two simultaneous INSERTs from different services would both see the same `prev_hash` and produce a branch — `verifyChain` would later flag it as a chain break.

## Verification

`POST /audit/verify { from_seq?, to_seq? }` recomputes every row's `entry_hash` in the requested range and walks the `prev_hash` links forward. Returns:

```json
{
  "verified": true,
  "rows_scanned": 3,
  "broken_at": null
}
```

…or `{ "verified": false, "broken_at": { "broken_at_event_id": "…", "expected": "…", "actual": "…" } }` on tamper.

Range scans are capped at `verifyMaxRows` (default 1000). A range that would exceed the cap returns 400 `VERIFY_RANGE_TOO_LARGE` — narrow it via `from_seq` / `to_seq`. Production-scale verification is a scheduled job (per ADR 0010 evolution path); the HTTP endpoint is the operator-on-demand path.

## Configuration

| Var             | Default    |
| --------------- | ---------- |
| `PORT`          | `3007`     |
| `REDIS_HOST`    | `redis`    |
| `POSTGRES_HOST` | `postgres` |
