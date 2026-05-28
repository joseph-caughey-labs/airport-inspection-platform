import { describe, expect, it, vi } from "vitest";
import { withTransaction } from "../../../packages/postgres-client/src/index.js";

/**
 * In-memory fake of pg's `Pool` / `PoolClient` surface. We only need
 * `connect()` returning a client with `query()` and `release()`.
 */
function makeFakePool() {
  const calls: string[] = [];
  const released: number[] = [];
  const queryFn = vi.fn(async (sql: string) => {
    calls.push(sql);
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn(() => {
    released.push(Date.now());
  });
  const connect = vi.fn(async () => ({
    query: queryFn,
    release,
  }));
  return {
    pool: { connect } as unknown as import("pg").Pool,
    calls,
    queryFn,
    release,
  };
}

describe("withTransaction", () => {
  it("issues BEGIN/COMMIT around fn and returns its value", async () => {
    const { pool, calls, release } = makeFakePool();
    const result = await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO x VALUES (1)");
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toEqual(["BEGIN", "INSERT INTO x VALUES (1)", "COMMIT"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("issues ROLLBACK and rethrows when fn throws", async () => {
    const { pool, calls, release } = makeFakePool();
    await expect(
      withTransaction(pool, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("still releases the client when ROLLBACK itself fails", async () => {
    const calls: string[] = [];
    const release = vi.fn();
    const queryFn = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "ROLLBACK") throw new Error("network gone");
      if (sql === "BEGIN") return { rows: [], rowCount: 0 };
      throw new Error("inner fail");
    });
    const pool = {
      connect: vi.fn(async () => ({ query: queryFn, release })),
    } as unknown as import("pg").Pool;

    await expect(
      withTransaction(pool, async (client) => {
        await client.query("inner fail");
        return 1;
      }),
    ).rejects.toThrow("inner fail");
    expect(release).toHaveBeenCalledTimes(1);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("ROLLBACK");
  });

  it("passes the same client to fn that BEGIN used", async () => {
    const { pool, queryFn } = makeFakePool();
    await withTransaction(pool, async (client) => {
      await client.query("first");
      await client.query("second");
    });
    expect(queryFn).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(queryFn).toHaveBeenNthCalledWith(2, "first");
    expect(queryFn).toHaveBeenNthCalledWith(3, "second");
    expect(queryFn).toHaveBeenNthCalledWith(4, "COMMIT");
  });
});
