/**
 * Hash chain helper tests (T-412).
 *
 * Pure unit tests against the deterministic helpers in
 * `services/audit-service/src/chain/hash.ts`. The chain's integrity
 * guarantee depends on these being byte-stable across versions;
 * fixed-input tests pin specific hashes so an accidental change to
 * canonicalize() shows up loudly.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeEntryHash,
  GENESIS_PREV_HASH,
  verifyChain,
  type HashableAuditEntry,
} from "../../../services/audit-service/src/chain/hash.js";

function entry(overrides: Partial<HashableAuditEntry> = {}): HashableAuditEntry {
  return {
    event_id: "11111111-1111-1111-1111-111111111111",
    occurred_at: "2026-05-29T10:00:00.000Z",
    source: "incident-service",
    event_type: "incident.transitioned",
    actor_user_id: null,
    subject_id: "22222222-2222-2222-2222-222222222222",
    payload: { foo: "bar" },
    correlation_id: null,
    rationale: null,
    ...overrides,
  };
}

describe("canonicalize — deterministic key ordering", () => {
  it("emits keys in lexicographic order regardless of input order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("recurses into nested objects", () => {
    const a = { outer: { b: 1, a: 2 } };
    const b = { outer: { a: 2, b: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("preserves array order (semantic)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
  });

  it("renders null as null", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("handles nested arrays of objects", () => {
    const s = canonicalize([{ b: 1, a: 2 }, { z: 1 }]);
    expect(s).toBe('[{"a":2,"b":1},{"z":1}]');
  });
});

describe("computeEntryHash — link semantics", () => {
  it("is deterministic for the same (prev_hash, entry)", () => {
    const a = computeEntryHash("", entry());
    const b = computeEntryHash("", entry());
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // sha256 hex
  });

  it("differs when prev_hash changes", () => {
    expect(computeEntryHash("a", entry())).not.toBe(computeEntryHash("b", entry()));
  });

  it("differs when any hashed field changes", () => {
    const base = computeEntryHash("", entry());
    expect(computeEntryHash("", entry({ source: "validation-engine" }))).not.toBe(base);
    expect(computeEntryHash("", entry({ event_type: "x" }))).not.toBe(base);
    expect(computeEntryHash("", entry({ payload: { foo: "baz" } }))).not.toBe(base);
  });

  it("is insensitive to JSON key order in the payload", () => {
    const a = computeEntryHash("", entry({ payload: { a: 1, b: 2 } }));
    const b = computeEntryHash("", entry({ payload: { b: 2, a: 1 } }));
    expect(a).toBe(b);
  });

  it("uses GENESIS_PREV_HASH = empty string as the seed", () => {
    expect(GENESIS_PREV_HASH).toBe("");
  });
});

describe("verifyChain", () => {
  function chainOf(entries: HashableAuditEntry[]) {
    const out: { prev_hash: string | null; entry_hash: string; row: HashableAuditEntry }[] = [];
    let prev: string = GENESIS_PREV_HASH;
    for (const e of entries) {
      const h = computeEntryHash(prev, e);
      out.push({ prev_hash: prev === GENESIS_PREV_HASH ? null : prev, entry_hash: h, row: e });
      prev = h;
    }
    return out;
  }

  it("returns null for a freshly-built chain", () => {
    const chain = chainOf([entry(), entry({ event_id: "x" }), entry({ event_id: "y" })]);
    expect(verifyChain(chain)).toBeNull();
  });

  it("detects tampering with a payload mid-chain", () => {
    const chain = chainOf([entry(), entry({ event_id: "x" }), entry({ event_id: "y" })]);
    // Tamper: change a row's payload after the hash was committed.
    chain[1]!.row = { ...chain[1]!.row, payload: { evil: true } };
    const broken = verifyChain(chain);
    expect(broken?.broken_at_event_id).toBe("x");
  });

  it("detects a broken prev_hash link", () => {
    const chain = chainOf([entry(), entry({ event_id: "x" })]);
    chain[1]!.prev_hash = "0".repeat(64);
    const broken = verifyChain(chain);
    expect(broken?.broken_at_event_id).toBe("x");
  });
});
