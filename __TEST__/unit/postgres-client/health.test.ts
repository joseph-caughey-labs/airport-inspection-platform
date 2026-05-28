import { describe, expect, it, vi } from "vitest";
import { checkHealth } from "../../../packages/postgres-client/src/index.js";

function makePool(queryImpl: (sql: string) => Promise<unknown>) {
  return {
    query: vi.fn(queryImpl),
  } as unknown as import("pg").Pool;
}

describe("checkHealth", () => {
  it("returns healthy with latency_ms on success", async () => {
    const pool = makePool(async () => ({ rows: [{ "?column?": 1 }] }));
    const result = await checkHealth(pool);
    expect(result.healthy).toBe(true);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("returns unhealthy with the error message when query throws", async () => {
    const pool = makePool(async () => {
      throw new Error("connection refused");
    });
    const result = await checkHealth(pool);
    expect(result.healthy).toBe(false);
    expect(result.error).toBe("connection refused");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("does not leak stack traces in the error field", async () => {
    const pool = makePool(async () => {
      const err = new Error("connection refused");
      err.stack = "Error: connection refused\n    at hidden:1:1";
      throw err;
    });
    const result = await checkHealth(pool);
    expect(result.error).toBe("connection refused");
    expect(result.error).not.toContain("at hidden");
  });

  it("handles non-Error throws", async () => {
    const pool = makePool(async () => {
      throw "not even an error"; // eslint-disable-line @typescript-eslint/no-throw-literal
    });
    const result = await checkHealth(pool);
    expect(result.healthy).toBe(false);
    expect(result.error).toBe("unknown error");
  });

  it("issues a cheap SELECT 1 query", async () => {
    const queryFn = vi.fn(async () => ({ rows: [] }));
    const pool = { query: queryFn } as unknown as import("pg").Pool;
    await checkHealth(pool);
    expect(queryFn).toHaveBeenCalledWith("SELECT 1");
  });
});
