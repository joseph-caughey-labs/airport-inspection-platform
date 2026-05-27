import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/audit-service/src/app.js";

const logger = createLogger({ service: "audit-service-test", level: "fatal" });

function healthyRedis(): import("ioredis").default {
  return { ping: vi.fn(async () => "PONG") } as unknown as import("ioredis").default;
}

function healthyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })),
  } as unknown as import("pg").Pool;
}

describe("audit-service — shell", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger, redis: healthyRedis(), pool: healthyPool() });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /ready returns 200 when both deps are up", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });

  it("GET /audit/events returns empty placeholder envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/audit/events" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
  });
});
