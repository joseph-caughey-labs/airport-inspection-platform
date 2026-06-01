import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../../../services/ws-broadcaster/src/app.js";

const logger = createLogger({ service: "ws-broadcaster-test", level: "fatal" });

// 32+ byte HS256 secret. The api-gateway and ws-broadcaster share the
// same JWT_SECRET in this demo posture; tests sign with that same secret
// via `createJwtSigner`.
const TEST_SECRET = "test-secret-must-be-at-least-32-bytes-long-please";
const TEST_ISSUER = "aip-api-gateway";

function makeSigner(): ReturnType<typeof createJwtSigner> {
  return createJwtSigner({ secret: TEST_SECRET, issuer: TEST_ISSUER });
}

async function operatorToken(signer: ReturnType<typeof createJwtSigner>): Promise<string> {
  return signer.signAccess({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    role: "operator",
  });
}

async function reviewerToken(signer: ReturnType<typeof createJwtSigner>): Promise<string> {
  return signer.signAccess({
    user_id: "00000000-0000-0000-0000-0000000000bb",
    role: "reviewer",
  });
}

function healthyRedis(): import("ioredis").default {
  return { ping: vi.fn(async () => "PONG") } as unknown as import("ioredis").default;
}

function emptyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as import("pg").Pool;
}

const AIRPORT = "11111111-2222-3333-4444-555555555555";

let built: Awaited<ReturnType<typeof buildApp>>;
let address: string;
let signer: ReturnType<typeof createJwtSigner>;
beforeEach(async () => {
  signer = makeSigner();
  built = await buildApp({
    logger,
    redis: healthyRedis(),
    pool: emptyPool(),
    registry: createRegistry({ service: "ws-broadcaster-test", collectDefault: false }),
    signer,
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
  it("rejects malformed airport ids with close code 4400 (no auth needed)", async () => {
    // Airport id is checked before auth so a malformed id closes early.
    const url = `ws://${address}/ws/v1/airport/not-a-uuid/events`;
    const sock = new WebSocket(url);
    const code = await new Promise<number>((resolve, reject) => {
      sock.on("close", (c) => resolve(c));
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 2000);
    });
    expect(code).toBe(4400);
  });

  it("accepts a valid airport uuid with a valid operator token and stays open", async () => {
    const token = await operatorToken(signer);
    const url = `ws://${address}/ws/v1/airport/${AIRPORT}/events?access_token=${token}`;
    const sock = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      sock.on("open", () => resolve());
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws open timeout")), 2000);
    });
    expect(sock.readyState).toBe(WebSocket.OPEN);
    sock.close();
  });

  it("sends a presence.snapshot as the first message after authenticated connect", async () => {
    const token = await operatorToken(signer);
    const url = `ws://${address}/ws/v1/airport/${AIRPORT}/events?access_token=${token}`;
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
    expect(parsed.payload.airport_id).toBe(AIRPORT);
  });
});

describe("ws-broadcaster — auth (T-504b)", () => {
  // 4401 mirrors HTTP 401; the 4xxx range is application-defined per
  // the WS close-code spec.
  it("closes with 4401 when no access token is provided", async () => {
    const url = `ws://${address}/ws/v1/airport/${AIRPORT}/events`;
    const sock = new WebSocket(url);
    const code = await new Promise<number>((resolve, reject) => {
      sock.on("close", (c) => resolve(c));
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 2000);
    });
    expect(code).toBe(4401);
  });

  it("closes with 4401 when the access token is malformed", async () => {
    const url = `ws://${address}/ws/v1/airport/${AIRPORT}/events?access_token=not-a-real-jwt`;
    const sock = new WebSocket(url);
    const code = await new Promise<number>((resolve, reject) => {
      sock.on("close", (c) => resolve(c));
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 2000);
    });
    expect(code).toBe(4401);
  });

  it("closes with 4401 when a refresh token is presented in place of an access token", async () => {
    // Wrong-kind: signAccess vs signRefresh produce different `kind`
    // claims; verifyAccess must reject a refresh token.
    const refresh = await signer.signRefresh({ user_id: "00000000-0000-0000-0000-0000000000aa" });
    const url = `ws://${address}/ws/v1/airport/${AIRPORT}/events?access_token=${refresh}`;
    const sock = new WebSocket(url);
    const code = await new Promise<number>((resolve, reject) => {
      sock.on("close", (c) => resolve(c));
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 2000);
    });
    expect(code).toBe(4401);
  });

  it("accepts a token presented via Sec-WebSocket-Protocol: bearer.<token>", async () => {
    const token = await operatorToken(signer);
    const url = `ws://${address}/ws/v1/airport/${AIRPORT}/events`;
    const sock = new WebSocket(url, [`bearer.${token}`]);
    await new Promise<void>((resolve, reject) => {
      sock.on("open", () => resolve());
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws open timeout")), 2000);
    });
    expect(sock.readyState).toBe(WebSocket.OPEN);
    sock.close();
  });

  it("prefers the subprotocol token when both subprotocol and query string are present", async () => {
    // Hand a valid token via subprotocol and a garbage one via query
    // string — the subprotocol path is checked first and must win.
    const goodToken = await operatorToken(signer);
    const url = `ws://${address}/ws/v1/airport/${AIRPORT}/events?access_token=not-a-real-jwt`;
    const sock = new WebSocket(url, [`bearer.${goodToken}`]);
    await new Promise<void>((resolve, reject) => {
      sock.on("open", () => resolve());
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws open timeout")), 2000);
    });
    expect(sock.readyState).toBe(WebSocket.OPEN);
    sock.close();
  });

  it("still rejects a malformed airport id even if the token is valid", async () => {
    const token = await operatorToken(signer);
    const url = `ws://${address}/ws/v1/airport/not-a-uuid/events?access_token=${token}`;
    const sock = new WebSocket(url);
    const code = await new Promise<number>((resolve, reject) => {
      sock.on("close", (c) => resolve(c));
      sock.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 2000);
    });
    expect(code).toBe(4400);
  });

  it("maps a reviewer auth role to supervisor in the presence snapshot subscribers", async () => {
    // The route sends presence.snapshot BEFORE subscribing the new
    // client, so a single connection's snapshot is empty. To observe
    // the role mapping we connect reviewer #1 first, then reviewer #2
    // — #2's snapshot must contain #1 as supervisor.
    const token = await reviewerToken(signer);
    const url = `ws://${address}/ws/v1/airport/${AIRPORT}/events?access_token=${token}`;

    const first = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      first.on("message", () => resolve());
      first.on("error", reject);
      setTimeout(() => reject(new Error("ws #1 timeout")), 2000);
    });

    const second = new WebSocket(url);
    const secondFrame = await new Promise<string>((resolve, reject) => {
      second.on("message", (data) => resolve(data.toString()));
      second.on("error", reject);
      setTimeout(() => reject(new Error("ws #2 timeout")), 2000);
    });
    const parsed = JSON.parse(secondFrame);
    expect(parsed.type).toBe("presence.snapshot");
    const subscribers = parsed.payload.subscribers as Array<{ role: string }>;
    expect(subscribers.some((s) => s.role === "supervisor")).toBe(true);
    expect(subscribers.some((s) => s.role === "operator")).toBe(false);

    first.close();
    second.close();
  });
});
