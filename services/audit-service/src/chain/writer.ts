/**
 * Append-only INSERT path for `audit_events`.
 *
 * Each call to `append()`:
 *   1. Acquires an xact-scoped advisory lock so concurrent writers
 *      from different services serialize on the same chain tip.
 *      Without this, two simultaneous INSERTs would both see the
 *      same `prev_hash` and produce a branch — which the verifier
 *      would later flag as a chain break.
 *   2. Reads the current chain tip (`entry_hash` of the highest
 *      `seq`).
 *   3. Computes the new `entry_hash` using the pure helper in
 *      `./hash.ts`.
 *   4. INSERTs the row and commits.
 *
 * The transaction also covers the SELECT so the read + INSERT are
 * a single atomic unit — required for the chain invariant.
 *
 * Errors propagate to the caller (the Redis subscriber) so the
 * underlying psubscribe loop counts the failure + lets ioredis
 * redeliver on reconnect.
 */
import { randomUUID } from "node:crypto";
import type { PgPool } from "@aip/postgres-client";
import { computeEntryHash, GENESIS_PREV_HASH, type HashableAuditEntry } from "./hash.js";

export interface AuditAppendInput {
  source: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at?: string;
  actor_user_id?: string | null;
  subject_id?: string | null;
  correlation_id?: string | null;
  rationale?: string | null;
  /** Test seam: when omitted, generated. */
  event_id?: string;
}

export interface AuditAppendedRow {
  seq: bigint;
  event_id: string;
  occurred_at: string;
  source: string;
  event_type: string;
  actor_user_id: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string | null;
  entry_hash: string;
  correlation_id: string | null;
  rationale: string | null;
}

/**
 * Fixed key for the chain-tip advisory lock. Distinct per process
 * isn't enough — distinct services share this lock so a
 * notification-service emit doesn't race a validation-engine emit.
 */
const CHAIN_TIP_LOCK_KEY = 0xa0d10de1; // "AUDIT" in pseudo-hex; any stable constant works

export class AuditChainWriter {
  constructor(private readonly pool: PgPool) {}

  async append(input: AuditAppendInput): Promise<AuditAppendedRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [CHAIN_TIP_LOCK_KEY]);

      const tip = await client.query<{ entry_hash: string }>(
        "SELECT entry_hash FROM audit_events ORDER BY seq DESC LIMIT 1",
      );
      const prevHash = tip.rows[0]?.entry_hash ?? GENESIS_PREV_HASH;

      const hashable: HashableAuditEntry = {
        event_id: input.event_id ?? randomUUID(),
        occurred_at: input.occurred_at ?? new Date().toISOString(),
        source: input.source,
        event_type: input.event_type,
        actor_user_id: input.actor_user_id ?? null,
        subject_id: input.subject_id ?? null,
        payload: input.payload,
        correlation_id: input.correlation_id ?? null,
        rationale: input.rationale ?? null,
      };
      const entryHash = computeEntryHash(prevHash, hashable);

      const inserted = await client.query<AuditAppendedRow>(
        `INSERT INTO audit_events
           (event_id, occurred_at, source, event_type, actor_user_id,
            subject_id, payload, prev_hash, entry_hash,
            correlation_id, rationale)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING seq, event_id, occurred_at, source, event_type,
                   actor_user_id, subject_id, payload, prev_hash,
                   entry_hash, correlation_id, rationale`,
        [
          hashable.event_id,
          hashable.occurred_at,
          hashable.source,
          hashable.event_type,
          hashable.actor_user_id,
          hashable.subject_id,
          hashable.payload,
          // First entry uses prev_hash NULL in the column (the
          // genesis seed is the empty string in the hash domain).
          prevHash === GENESIS_PREV_HASH ? null : prevHash,
          entryHash,
          hashable.correlation_id,
          hashable.rationale,
        ],
      );
      await client.query("COMMIT");
      return inserted.rows[0]!;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
