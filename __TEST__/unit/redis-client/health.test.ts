import { describe, expect, it, vi } from "vitest";
import { checkHealth } from "../../../packages/redis-client/src/index.js";

function makeRedis(pingImpl: () => Promise<string>) {
  return { ping: vi.fn(pingImpl) } as unknown as import("ioredis").default;
}

describe("checkHealth", () => {
  it("returns healthy when PING returns PONG", async () => {
    const redis = makeRedis(async () => "PONG");
    const result = await checkHealth(redis);
    expect(result.healthy).toBe(true);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("returns unhealthy when PING returns an unexpected reply", async () => {
    const redis = makeRedis(async () => "what?");
    const result = await checkHealth(redis);
    expect(result.healthy).toBe(false);
    expect(result.error).toContain("unexpected reply");
  });

  it("returns unhealthy with the error message when PING throws", async () => {
    const redis = makeRedis(async () => {
      throw new Error("connection refused");
    });
    const result = await checkHealth(redis);
    expect(result.healthy).toBe(false);
    expect(result.error).toBe("connection refused");
  });

  it("does not leak stack traces in the error field", async () => {
    const redis = makeRedis(async () => {
      const err = new Error("connection refused");
      err.stack = "Error: connection refused\n    at hidden:1:1";
      throw err;
    });
    const result = await checkHealth(redis);
    expect(result.error).toBe("connection refused");
    expect(result.error).not.toContain("at hidden");
  });

  it("handles non-Error throws", async () => {
    const redis = makeRedis(async () => {
      throw "string thrown"; // eslint-disable-line @typescript-eslint/no-throw-literal
    });
    const result = await checkHealth(redis);
    expect(result.healthy).toBe(false);
    expect(result.error).toBe("unknown error");
  });
});
