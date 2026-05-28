import { describe, expect, it, vi } from "vitest";
import { seedFromJson } from "../../../packages/db-schema/src/index.js";

/**
 * Fake pg.Pool that records SQL + params for every call. Lets us
 * verify ordering (airports before runways/sensors), idempotency
 * (ON CONFLICT DO NOTHING in every INSERT), and transaction wrapping
 * without spinning up Postgres.
 */
function makeFakePool() {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, ...(params ? { params } : {}) });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(async () => client);
  return {
    pool: { connect } as unknown as import("pg").Pool,
    client,
    calls,
  };
}

describe("seedFromJson", () => {
  it("wraps all inserts in a single BEGIN/COMMIT", async () => {
    const { pool, client } = makeFakePool();
    await seedFromJson(pool);
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
  });

  it("inserts airports before runways and sensors (FK order)", async () => {
    const { pool, calls } = makeFakePool();
    await seedFromJson(pool);
    const firstAirport = calls.findIndex((c) => c.sql.includes("INTO airports"));
    const firstRunway = calls.findIndex((c) => c.sql.includes("INTO runways"));
    const firstSensor = calls.findIndex((c) => c.sql.includes("INTO sensors"));
    expect(firstAirport).toBeGreaterThan(-1);
    expect(firstRunway).toBeGreaterThan(firstAirport);
    expect(firstSensor).toBeGreaterThan(firstAirport);
  });

  it("uses ON CONFLICT DO NOTHING on every INSERT (idempotent)", async () => {
    const { pool, calls } = makeFakePool();
    await seedFromJson(pool);
    const inserts = calls.filter((c) => c.sql.includes("INSERT INTO"));
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) {
      expect(ins.sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    }
  });

  it("inserts the canonical seed counts on first run", async () => {
    const { pool } = makeFakePool();
    const result = await seedFromJson(pool);
    // Mirrors data/seed/*.json. If the JSON content drifts and these
    // numbers change, that's a Domain Expert signal — update both.
    expect(result.airports).toBe(2);
    expect(result.runways).toBe(4);
    expect(result.sensors).toBe(11);
    expect(result.users).toBe(3);
  });

  it("rolls back when an insert fails", async () => {
    const { pool, client } = makeFakePool();
    client.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })); // BEGIN
    client.query.mockImplementationOnce(async () => {
      throw new Error("CHECK constraint violation");
    });
    await expect(seedFromJson(pool)).rejects.toThrow(/constraint violation/);
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });

  it("uses caller-supplied seedDir override", async () => {
    const { pool } = makeFakePool();
    await expect(seedFromJson(pool, { seedDir: "/tmp/non-existent-dir-12345" })).rejects.toThrow(
      /ENOENT|no such file/i,
    );
  });
});
