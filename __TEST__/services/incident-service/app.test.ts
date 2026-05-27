import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/incident-service/src/app.js";

const logger = createLogger({ service: "incident-service-test", level: "fatal" });

function healthyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })),
  } as unknown as import("pg").Pool;
}

describe("incident-service — shell", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger, pool: healthyPool() });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200 ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /ready returns 200 when Postgres is up", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });

  it("GET /incidents returns the empty placeholder envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/incidents" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
  });
});
