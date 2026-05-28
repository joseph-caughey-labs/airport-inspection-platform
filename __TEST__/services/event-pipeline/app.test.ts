import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/event-pipeline/src/app.js";

function makeRegistry() {
  return createRegistry({ service: "event-pipeline-test", collectDefault: false });
}

const logger = createLogger({ service: "event-pipeline-test", level: "fatal" });

function healthyRedis(): import("ioredis").default {
  return { ping: vi.fn(async () => "PONG") } as unknown as import("ioredis").default;
}

function unhealthyRedis(): import("ioredis").default {
  return {
    ping: vi.fn(async () => {
      throw new Error("redis down");
    }),
  } as unknown as import("ioredis").default;
}

function healthyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })),
  } as unknown as import("pg").Pool;
}

function unhealthyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => {
      throw new Error("postgres down");
    }),
  } as unknown as import("pg").Pool;
}

describe("event-pipeline — health and ready", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({
      logger,
      redis: healthyRedis(),
      pool: healthyPool(),
      registry: makeRegistry(),
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200 ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /ready returns 200 when both deps are healthy", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });

  it("GET /ready returns 503 when Redis is unreachable", async () => {
    const downApp = await buildApp({
      logger,
      redis: unhealthyRedis(),
      pool: healthyPool(),
      registry: makeRegistry(),
    });
    const res = await downApp.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { redis: { healthy: boolean } }).redis.healthy).toBe(false);
    await downApp.close();
  });

  it("GET /ready returns 503 when Postgres is unreachable", async () => {
    const downApp = await buildApp({
      logger,
      redis: healthyRedis(),
      pool: unhealthyPool(),
      registry: makeRegistry(),
    });
    const res = await downApp.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { postgres: { healthy: boolean } }).postgres.healthy).toBe(false);
    await downApp.close();
  });
});
