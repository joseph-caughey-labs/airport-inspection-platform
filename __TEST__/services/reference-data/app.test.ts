import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/reference-data/src/app.js";

/**
 * Fake pg.Pool that supports just enough surface for `checkHealth`
 * (the only DB call our health/ready/sop-baseline tests need).
 *
 * Drizzle-routed entity endpoints (/airports, /runways, /sensors) are
 * exercised in the integration tier (`__TEST__/integration/`) against
 * a real Postgres seeded by T-118 — that's where they have value.
 * Mocking Drizzle's internal driver behaviour at the unit tier is
 * brittle and tests the mock, not the code.
 */
function makeHealthyPool(): import("pg").Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.trim().toLowerCase() === "select 1") {
        return { rows: [{ "?column?": 1 }] };
      }
      return { rows: [] };
    }),
  } as unknown as import("pg").Pool;
}

function makeUnhealthyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => {
      throw new Error("connection refused");
    }),
  } as unknown as import("pg").Pool;
}

const logger = createLogger({
  service: "reference-data-test",
  level: "fatal",
});

describe("reference-data — health endpoints", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger, pool: makeHealthyPool() });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200 ok regardless of DB state", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("GET /ready returns 200 + latency_ms when DB is healthy", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; latency_ms: number };
    expect(body.status).toBe("ready");
    expect(typeof body.latency_ms).toBe("number");
  });

  it("GET /ready returns 503 when DB is unreachable", async () => {
    const downApp = await buildApp({ logger, pool: makeUnhealthyPool() });
    const res = await downApp.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; error?: string };
    expect(body.status).toBe("unhealthy");
    expect(body.error).toBe("connection refused");
    await downApp.close();
  });

  it("GET /ready does NOT leak stack traces", async () => {
    const downApp = await buildApp({ logger, pool: makeUnhealthyPool() });
    const res = await downApp.inject({ method: "GET", url: "/ready" });
    const text = res.body;
    expect(text).not.toContain("at ");
    expect(text).not.toContain("/node_modules/");
    await downApp.close();
  });
});

describe("reference-data — sop-baseline", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger, pool: makeHealthyPool() });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /sop-baseline returns the structured placeholder", async () => {
    const res = await app.inject({ method: "GET", url: "/sop-baseline" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("snowbank");
    expect(body).toHaveProperty("fod");
    expect(body).toHaveProperty("crack");
  });

  it("/sop-baseline.snowbank exposes height + setback thresholds", async () => {
    const res = await app.inject({ method: "GET", url: "/sop-baseline" });
    const body = res.json() as {
      snowbank: { max_height_cm: number; runway_setback_min_m: number };
    };
    expect(typeof body.snowbank.max_height_cm).toBe("number");
    expect(typeof body.snowbank.runway_setback_min_m).toBe("number");
  });

  it("/sop-baseline.fod has location-severity mapping", async () => {
    const res = await app.inject({ method: "GET", url: "/sop-baseline" });
    const body = res.json() as {
      fod: { location_severity: Record<string, string> };
    };
    expect(body.fod.location_severity).toHaveProperty("runway_active");
    expect(body.fod.location_severity["runway_active"]).toBe("critical");
  });
});

describe("reference-data — unknown routes", () => {
  it("returns 404 with no stack trace", async () => {
    const app = await buildApp({ logger, pool: makeHealthyPool() });
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("at ");
    await app.close();
  });
});
