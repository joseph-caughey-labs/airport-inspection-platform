import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../../services/api-gateway/src/app.js";

const logger = createLogger({ service: "api-gateway-test", level: "fatal" });

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  app = await buildApp({
    logger,
    registry: createRegistry({ service: "api-gateway-test", collectDefault: false }),
  });
});
afterEach(async () => {
  await app.close();
});

describe("api-gateway — health and ready", () => {
  it("GET /health returns 200 ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("GET /ready returns 200 ready", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });
});

describe("api-gateway — metrics", () => {
  it("GET /metrics returns the prometheus exposition", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });
});

describe("api-gateway — request id", () => {
  it("generates an x-request-id when missing and echoes it on response", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ping" });
    expect(res.statusCode).toBe(200);
    const requestId = res.headers["x-request-id"];
    expect(typeof requestId).toBe("string");
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((res.json() as { request_id: string }).request_id).toBe(requestId);
  });

  it("preserves an inbound x-request-id and echoes it back", async () => {
    const supplied = "11111111-2222-3333-4444-555555555555";
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ping",
      headers: { "x-request-id": supplied },
    });
    expect(res.headers["x-request-id"]).toBe(supplied);
    expect((res.json() as { request_id: string }).request_id).toBe(supplied);
  });

  it("also generates an x-correlation-id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ping" });
    expect(res.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("api-gateway — /api/v1/ping", () => {
  it("returns pong=true with iso timestamp and request_id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ping" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pong: boolean;
      time: string;
      request_id: string;
      auth?: unknown;
    };
    expect(body.pong).toBe(true);
    expect(body.time).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof body.request_id).toBe("string");
    expect(body.auth).toBeUndefined();
  });

  it("attaches decoded auth when a well-formed Bearer token is present", async () => {
    const userId = "11111111-2222-3333-4444-555555555555";
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ping",
      headers: { authorization: `Bearer ${userId}.operator` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      auth?: { userId: string; role: string };
    };
    expect(body.auth).toEqual({ userId, role: "operator" });
  });

  it("omits auth when the token role is invalid", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ping",
      headers: { authorization: "Bearer some-id.god-mode" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { auth?: unknown }).auth).toBeUndefined();
  });

  it("omits auth when the token is malformed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ping",
      headers: { authorization: "Bearer not-a-valid-token" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { auth?: unknown }).auth).toBeUndefined();
  });

  it("ignores non-Bearer authorization schemes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ping",
      headers: { authorization: "Basic Zm9vOmJhcg==" },
    });
    expect((res.json() as { auth?: unknown }).auth).toBeUndefined();
  });
});

describe("api-gateway — error envelope", () => {
  it("returns canonical ErrorResponse on 404", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as {
      error: { code: string; message: string; correlation_id?: string };
    };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("/does-not-exist");
    expect(body.error.correlation_id).toBeDefined();
  });

  it("does not leak stack traces on errors", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.body).not.toContain("at ");
    expect(res.body).not.toContain("node_modules");
  });
});
