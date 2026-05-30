/**
 * AuditChainWriter tests (T-412).
 *
 * Uses a hand-rolled fake `PgPool` that records every query so we
 * can assert the transactional INSERT path runs in the right order:
 *
 *   BEGIN → advisory lock → SELECT tip → INSERT → COMMIT
 *
 * The fake also lets us simulate empty + non-empty chain tips so
 * both genesis and follow-on appends are exercised.
 */
import { describe, expect, it, vi } from "vitest";
import { AuditChainWriter } from "../../../services/audit-service/src/chain/writer.js";
import {
  computeEntryHash,
  GENESIS_PREV_HASH,
} from "../../../services/audit-service/src/chain/hash.js";

interface FakeClient {
  queries: { sql: string; params: unknown[] }[];
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

interface FakePool {
  connect: () => Promise<FakeClient>;
  clients: FakeClient[];
}

function fakePool(tipHash: string | null, insertReturning: Record<string, unknown>): FakePool {
  const clients: FakeClient[] = [];
  return {
    clients,
    async connect(): Promise<FakeClient> {
      const queries: { sql: string; params: unknown[] }[] = [];
      const client: FakeClient = {
        queries,
        async query(sql: string, params: unknown[] = []) {
          queries.push({ sql, params });
          if (sql.startsWith("SELECT entry_hash FROM audit_events")) {
            return { rows: tipHash !== null ? [{ entry_hash: tipHash }] : [] };
          }
          if (sql.startsWith("INSERT INTO audit_events")) {
            return { rows: [insertReturning] };
          }
          return { rows: [] };
        },
        release: vi.fn(),
      };
      clients.push(client);
      return client;
    },
  };
}

describe("AuditChainWriter.append", () => {
  it("uses GENESIS_PREV_HASH as prev_hash for the first row", async () => {
    const inserted = {
      seq: 1n,
      event_id: "11111111-1111-1111-1111-111111111111",
      occurred_at: "2026-05-29T10:00:00.000Z",
      source: "incident-service",
      event_type: "incident.transitioned",
      actor_user_id: null,
      subject_id: "incident-1",
      payload: { foo: 1 },
      prev_hash: null,
      entry_hash: "deadbeef",
      correlation_id: null,
      rationale: null,
    };
    const pool = fakePool(null, inserted);
    const writer = new AuditChainWriter(pool as unknown as import("pg").Pool);

    const row = await writer.append({
      event_id: inserted.event_id,
      occurred_at: inserted.occurred_at,
      source: "incident-service",
      event_type: "incident.transitioned",
      subject_id: "incident-1",
      payload: { foo: 1 },
    });

    expect(row.event_id).toBe(inserted.event_id);
    const client = pool.clients[0]!;
    // Order matters: BEGIN, advisory lock, SELECT tip, INSERT, COMMIT.
    expect(client.queries.map((q) => q.sql.split(" ")[0])).toEqual([
      "BEGIN",
      "SELECT",
      "SELECT",
      "INSERT",
      "COMMIT",
    ]);
    // Lock acquired before the read.
    expect(client.queries[1]!.sql).toContain("pg_advisory_xact_lock");
    // INSERT params: prev_hash is null on genesis, entry_hash is the
    // sha256 over the canonical entry with prev = "" seed.
    const insert = client.queries[3]!;
    expect(insert.params[7]).toBeNull(); // prev_hash column
    expect(insert.params[8]).toBe(
      computeEntryHash(GENESIS_PREV_HASH, {
        event_id: inserted.event_id,
        occurred_at: inserted.occurred_at,
        source: "incident-service",
        event_type: "incident.transitioned",
        actor_user_id: null,
        subject_id: "incident-1",
        payload: { foo: 1 },
        correlation_id: null,
        rationale: null,
      }),
    );
  });

  it("threads the existing tip hash forward as prev_hash on follow-on inserts", async () => {
    const tip = "a".repeat(64);
    const pool = fakePool(tip, {
      seq: 5n,
      event_id: "22222222-2222-2222-2222-222222222222",
      occurred_at: "2026-05-29T10:01:00.000Z",
      source: "incident-service",
      event_type: "incident.transitioned",
      actor_user_id: null,
      subject_id: "incident-2",
      payload: { x: 1 },
      prev_hash: tip,
      entry_hash: "beef",
      correlation_id: null,
      rationale: null,
    });
    const writer = new AuditChainWriter(pool as unknown as import("pg").Pool);
    await writer.append({
      event_id: "22222222-2222-2222-2222-222222222222",
      occurred_at: "2026-05-29T10:01:00.000Z",
      source: "incident-service",
      event_type: "incident.transitioned",
      subject_id: "incident-2",
      payload: { x: 1 },
    });
    const client = pool.clients[0]!;
    const insert = client.queries[3]!;
    expect(insert.params[7]).toBe(tip);
  });

  it("rolls back the transaction if the INSERT throws", async () => {
    const failingPool: FakePool = {
      clients: [],
      async connect() {
        const queries: { sql: string; params: unknown[] }[] = [];
        const client: FakeClient = {
          queries,
          async query(sql: string, params: unknown[] = []) {
            queries.push({ sql, params });
            if (sql.startsWith("SELECT entry_hash")) return { rows: [] };
            if (sql.startsWith("INSERT")) throw new Error("db down");
            return { rows: [] };
          },
          release: vi.fn(),
        };
        failingPool.clients.push(client);
        return client;
      },
    };
    const writer = new AuditChainWriter(failingPool as unknown as import("pg").Pool);
    await expect(
      writer.append({
        source: "incident-service",
        event_type: "incident.transitioned",
        subject_id: "x",
        payload: {},
      }),
    ).rejects.toThrow(/db down/);
    const sqls = failingPool.clients[0]!.queries.map((q) => q.sql.split(" ")[0]);
    expect(sqls).toContain("ROLLBACK");
  });
});
