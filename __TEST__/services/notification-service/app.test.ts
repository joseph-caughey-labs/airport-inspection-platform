import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/notification-service/src/app.js";

const logger = createLogger({
  service: "notification-service-test",
  level: "fatal",
});

function healthyRedis(): import("ioredis").default {
  return { ping: vi.fn(async () => "PONG") } as unknown as import("ioredis").default;
}

describe("notification-service — shell", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger, redis: healthyRedis() });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /ready returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });

  it("GET /channels returns the three stub channels", async () => {
    const res = await app.inject({ method: "GET", url: "/channels" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { channels: { name: string; status: string }[] };
    expect(body.channels.map((c) => c.name).sort()).toEqual(["email", "in_app", "webhook"]);
    expect(body.channels.every((c) => c.status === "stub")).toBe(true);
  });
});
