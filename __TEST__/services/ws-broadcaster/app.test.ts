import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../../../services/ws-broadcaster/src/app.js";

const logger = createLogger({ service: "ws-broadcaster-test", level: "fatal" });

function healthyRedis(): import("ioredis").default {
  return { ping: vi.fn(async () => "PONG") } as unknown as import("ioredis").default;
}

function emptyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as import("pg").Pool;
}

let built: Awaited<ReturnType<typeof buildApp>>;
let address: string;
beforeEach(async () => {
  built = await buildApp({
    logger,
    redis: healthyRedis(),
    pool: emptyPool(),
    registry: createRegistry({ service: "ws-broadcaster-test", collectDefault: false }),
  });
  address = (await built.app.listen({ port: 0, host: "127.0.0.1" })).replace("http://", "");
});
afterEach(async () => {
  await built.app.close();
});

describe("ws-broadcaster — health and ready", () => {
  it("GET /health returns 200 ok", async () => {
    const res = await built.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /ready returns 200 when Redis is healthy", async () => {
    const res = await built.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });

  it("GET /metrics exposes prom-client output", async () => {
    const res = await built.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
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

describe("ws-broadcaster — /ws/v1/airport/:id/events", () => {
  it("rejects malformed airport ids with close code 4400", async () => {
    const url = `ws://${address}/ws/v1/airport/not-a-uuid/events`;
    const sock = new WebSocket(url);
    const code = await new Promise<number>((resolve, reject) => {
      sock.on("close", (c) => resolve(c));
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 2000);
    });
    expect(code).toBe(4400);
  });

  it("accepts a valid airport uuid and stays open", async () => {
    const url = `ws://${address}/ws/v1/airport/11111111-2222-3333-4444-555555555555/events`;
    const sock = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      sock.on("open", () => resolve());
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws open timeout")), 2000);
    });
    expect(sock.readyState).toBe(WebSocket.OPEN);
    sock.close();
  });

  it("sends a presence.snapshot as the first message after connect", async () => {
    const url = `ws://${address}/ws/v1/airport/11111111-2222-3333-4444-555555555555/events`;
    const sock = new WebSocket(url);
    const firstFrame = await new Promise<string>((resolve, reject) => {
      sock.on("message", (data) => {
        resolve(data.toString());
        sock.close();
      });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 2000);
    });
    const parsed = JSON.parse(firstFrame);
    expect(parsed.type).toBe("presence.snapshot");
    expect(parsed.payload.airport_id).toBe("11111111-2222-3333-4444-555555555555");
  });
});
