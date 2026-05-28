import { createLogger } from "@aip/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../../../services/ws-broadcaster/src/app.js";

const logger = createLogger({ service: "ws-broadcaster-test", level: "fatal" });

function healthyRedis(): import("ioredis").default {
  return { ping: vi.fn(async () => "PONG") } as unknown as import("ioredis").default;
}

let app: Awaited<ReturnType<typeof buildApp>>;
let address: string;
beforeEach(async () => {
  app = await buildApp({ logger, redis: healthyRedis() });
  address = (await app.listen({ port: 0, host: "127.0.0.1" })).replace("http://", "");
});
afterEach(async () => {
  await app.close();
});

describe("ws-broadcaster — health and ready", () => {
  it("GET /health returns 200 ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /ready returns 200 when Redis is healthy", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });
});

describe("ws-broadcaster — /ws/v1/ping", () => {
  it("echoes a message back prefixed with pong:", async () => {
    const url = `ws://${address}/ws/v1/ping`;
    const sock = new WebSocket(url);
    const received = await new Promise<string>((resolve, reject) => {
      sock.on("open", () => sock.send("hello"));
      sock.on("message", (data) => {
        resolve(data.toString());
        sock.close();
      });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 2000);
    });
    expect(received).toBe("pong:hello");
  });
});
