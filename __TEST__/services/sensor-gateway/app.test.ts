import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/sensor-gateway/src/app.js";

function makeRedisStub(pingImpl: () => Promise<string>): import("ioredis").default {
  return { ping: vi.fn(pingImpl) } as unknown as import("ioredis").default;
}

const logger = createLogger({ service: "sensor-gateway-test", level: "fatal" });

describe("sensor-gateway — health and ready", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger, redis: makeRedisStub(async () => "PONG") });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200 ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("GET /ready returns 200 when Redis responds PONG", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });

  it("GET /ready returns 503 when Redis throws", async () => {
    const downApp = await buildApp({
      logger,
      redis: makeRedisStub(async () => {
        throw new Error("connection refused");
      }),
    });
    const res = await downApp.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("connection refused");
    await downApp.close();
  });
});
