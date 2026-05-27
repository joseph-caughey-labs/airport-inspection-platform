import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../../packages/db-schema/src/index.js";

/**
 * Fake `pg.Pool` that records every query and returns canned responses
 * keyed on a regex match. Lets us drive runMigrations through every
 * code path without spinning up Postgres.
 */
function makeFakePool() {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const responses = new Map<RegExp, (params?: unknown[]) => unknown>();

  const respondTo = (pattern: RegExp, handler: (params?: unknown[]) => unknown): void => {
    responses.set(pattern, handler);
  };

  const fire = async (sql: string, params?: unknown[]): Promise<unknown> => {
    calls.push({ sql, ...(params ? { params } : {}) });
    for (const [pattern, handler] of responses.entries()) {
      if (pattern.test(sql)) return handler(params);
    }
    return { rows: [], rowCount: 0 };
  };

  const query = vi.fn((sql: string, params?: unknown[]) => fire(sql, params));

  const client = {
    query,
    release: vi.fn(),
  };
  const connect = vi.fn(async () => client);

  return {
    pool: { query, connect } as unknown as import("pg").Pool,
    client,
    calls,
    respondTo,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(resolve(tmpdir(), "aip-migrate-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("runMigrations", () => {
  it("creates the _schema_migrations ledger if missing", async () => {
    const { pool, calls } = makeFakePool();
    await runMigrations(pool, { migrationsDir: tmp });
    expect(calls[0]?.sql).toMatch(/CREATE TABLE IF NOT EXISTS _schema_migrations/);
  });

  it("applies new migrations in lexical order", async () => {
    await writeFile(resolve(tmp, "0001_a.sql"), "SELECT 1;");
    await writeFile(resolve(tmp, "0002_b.sql"), "SELECT 2;");
    const { pool } = makeFakePool();
    const result = await runMigrations(pool, { migrationsDir: tmp });
    expect(result.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips already-applied migrations when hash matches", async () => {
    await writeFile(resolve(tmp, "0001_a.sql"), "SELECT 1;");
    const { pool, respondTo } = makeFakePool();
    // Pretend the ledger already has this migration with the matching hash.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update("SELECT 1;").digest("hex");
    respondTo(/SELECT sha256 FROM _schema_migrations/, () => ({
      rows: [{ sha256: hash }],
      rowCount: 1,
    }));
    const result = await runMigrations(pool, { migrationsDir: tmp });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["0001_a.sql"]);
  });

  it("throws when a previously applied migration's hash changed", async () => {
    await writeFile(resolve(tmp, "0001_a.sql"), "SELECT 999;"); // file changed
    const { pool, respondTo } = makeFakePool();
    respondTo(/SELECT sha256 FROM _schema_migrations/, () => ({
      rows: [{ sha256: "stale_hash_from_an_earlier_version" }],
      rowCount: 1,
    }));
    await expect(runMigrations(pool, { migrationsDir: tmp })).rejects.toThrow(
      /has changed since it was applied/,
    );
  });

  it("wraps each migration in a BEGIN/COMMIT transaction", async () => {
    await writeFile(resolve(tmp, "0001_a.sql"), "SELECT 1;");
    const { pool, client } = makeFakePool();
    await runMigrations(pool, { migrationsDir: tmp });
    const seq = client.query.mock.calls.map((c) => c[0] as string);
    // The transaction is wrapped via withTransaction (postgres-client),
    // which issues BEGIN before the migration body and COMMIT after.
    expect(seq).toContain("BEGIN");
    expect(seq).toContain("COMMIT");
    expect(seq.some((s) => s.includes("INSERT INTO _schema_migrations"))).toBe(true);
  });

  it("only includes .sql files (ignores other extensions)", async () => {
    await writeFile(resolve(tmp, "0001_a.sql"), "SELECT 1;");
    await writeFile(resolve(tmp, "README.md"), "# not a migration");
    await writeFile(resolve(tmp, "0002_b.sql.bak"), "SELECT 2;");
    const { pool } = makeFakePool();
    const result = await runMigrations(pool, { migrationsDir: tmp });
    expect(result.applied).toEqual(["0001_a.sql"]);
  });
});
