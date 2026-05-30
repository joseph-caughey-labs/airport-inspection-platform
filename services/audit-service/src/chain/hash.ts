/**
 * Pure hash-chain helpers for the append-only `audit_events` log.
 * No I/O — everything here is a deterministic function of its
 * inputs so the unit tests can pin behavior exactly.
 *
 * The chain links entries via:
 *
 *   entry_hash = sha256( prev_hash || canonical_json(entry without entry_hash) )
 *
 * where `prev_hash` is the previous row's `entry_hash` (or the
 * empty string for the first entry). Tampering with any row's
 * payload changes its `entry_hash`, which doesn't match what the
 * next row stored as its `prev_hash` — the chain breaks at the
 * tampered row and stays broken for every row after it.
 *
 * ADR 0010 layers this hash check on top of `REVOKE UPDATE/DELETE`
 * at the DB role level. The hash chain is the **detection** layer;
 * the GRANT revocation is the **prevention** layer.
 */
import { createHash } from "node:crypto";

/**
 * The minimal subset of an audit event used to compute its
 * `entry_hash`. We deliberately list every field rather than blindly
 * hashing the row so adding a new column (e.g. `redacted_at`) is a
 * conscious choice — silently including a new field in the hash
 * would break verification of older rows.
 */
export interface HashableAuditEntry {
  event_id: string;
  occurred_at: string;
  source: string;
  event_type: string;
  actor_user_id: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  rationale: string | null;
}

/** Sentinel used as `prev_hash` for the first entry in the chain. */
export const GENESIS_PREV_HASH = "";

/**
 * Canonicalize an arbitrary JSON value: sort object keys
 * lexicographically and remove insignificant whitespace.
 *
 * Two semantically-identical payloads produced by different
 * serializers must produce the same string — otherwise the same
 * event written twice from different code paths would hash
 * differently and break verification across services.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, canonicalReplacer(value));
}

/**
 * Compute `entry_hash` over `prev_hash || canonical_json(entry)`.
 *
 * `prev_hash` is concatenated as a UTF-8 string before the
 * canonicalized entry. The first entry uses `GENESIS_PREV_HASH`
 * (empty string) so verification of the very first row needs no
 * special case beyond knowing the seed.
 */
export function computeEntryHash(prevHash: string, entry: HashableAuditEntry): string {
  const canonical = canonicalize(toHashable(entry));
  return createHash("sha256").update(prevHash).update(canonical).digest("hex");
}

/**
 * Walk a sequence of entries (oldest → newest) and confirm every
 * row's `entry_hash` matches what the chain says it should be.
 * Returns the first row that breaks the chain, or `null` when the
 * full chain verifies.
 */
export function verifyChain(
  entries: { prev_hash: string | null; entry_hash: string; row: HashableAuditEntry }[],
): { broken_at_event_id: string; expected: string; actual: string } | null {
  let expectedPrev: string = GENESIS_PREV_HASH;
  for (const e of entries) {
    const seenPrev = e.prev_hash ?? GENESIS_PREV_HASH;
    if (seenPrev !== expectedPrev) {
      return {
        broken_at_event_id: e.row.event_id,
        expected: expectedPrev,
        actual: seenPrev,
      };
    }
    const recomputed = computeEntryHash(seenPrev, e.row);
    if (recomputed !== e.entry_hash) {
      return {
        broken_at_event_id: e.row.event_id,
        expected: recomputed,
        actual: e.entry_hash,
      };
    }
    expectedPrev = e.entry_hash;
  }
  return null;
}

function toHashable(entry: HashableAuditEntry): HashableAuditEntry {
  // Re-shape into a fresh object so the field order in
  // canonicalize() is deterministic and independent of how the
  // caller built `entry`.
  return {
    event_id: entry.event_id,
    occurred_at: entry.occurred_at,
    source: entry.source,
    event_type: entry.event_type,
    actor_user_id: entry.actor_user_id,
    subject_id: entry.subject_id,
    payload: entry.payload,
    correlation_id: entry.correlation_id,
    rationale: entry.rationale,
  };
}

/**
 * JSON.stringify replacer that sorts object keys. Arrays keep their
 * order (semantic). Primitives + null pass through.
 */
function canonicalReplacer(rootValue: unknown): (key: string, value: unknown) => unknown {
  let firstCall = true;
  return (_key: string, value: unknown) => {
    if (firstCall) {
      firstCall = false;
      return sortKeysDeep(rootValue);
    }
    return value;
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
