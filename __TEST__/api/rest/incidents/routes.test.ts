import { createLogger } from "@aip/logger";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../../services/incident-service/src/app.js";
import { InMemoryIncidentRepository } from "../../../../services/incident-service/src/repository/index.js";
import { adminToken, bearer, makeTestSigner } from "../../../helpers/auth.js";

const logger = createLogger({ service: "incident-routes-test", level: "fatal" });

function fakePool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as import("pg").Pool;
}

const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const OTHER = "11111111-1111-1111-1111-bbbbbbbbbbbb";

const signer = makeTestSigner();
let auth: { authorization: string };
beforeAll(async () => {
  auth = bearer(await adminToken(signer));
});

async function build(repo?: InMemoryIncidentRepository) {
  const repository = repo ?? new InMemoryIncidentRepository();
  const app = await buildApp({ logger, pool: fakePool(), repository, signer });
  // Wrap `inject` so every call carries the suite's admin token by
  // default. Tests in this file focus on route behaviour, not auth;
  // auth-specific cases live in __TEST__/services/incident-service.
  const originalInject = app.inject.bind(app);
  app.inject = ((opts: Parameters<typeof originalInject>[0]) => {
    if (typeof opts === "string") return originalInject({ url: opts, headers: auth });
    const merged = {
      ...opts,
      headers: { ...((opts as { headers?: Record<string, string> }).headers ?? {}), ...auth },
    };
    return originalInject(merged);
  }) as typeof originalInject;
  return { app, repository };
}

describe("POST /incidents", () => {
  it("creates an incident and returns 201 with the canonical envelope", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/incidents",
      payload: { airport_id: AIRPORT, severity: "high", title: "FOD on RWY 10L" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.airport_id).toBe(AIRPORT);
    expect(body.status).toBe("new");
  });

  it("returns 400 on a missing airport_id", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/incidents",
      payload: { severity: "high", title: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("returns 400 on a non-uuid airport_id", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/incidents",
      payload: { airport_id: "not-a-uuid", severity: "high", title: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on an invalid severity", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/incidents",
      payload: { airport_id: AIRPORT, severity: "fatal", title: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("collapses repeated POSTs with the same idempotency_key", async () => {
    const { app } = await build();
    const payload = {
      airport_id: AIRPORT,
      severity: "high",
      title: "FOD on RWY 10L",
      idempotency_key: "incident:CAM-1:F-1",
    };
    const first = (await app.inject({ method: "POST", url: "/incidents", payload })).json();
    const second = (await app.inject({ method: "POST", url: "/incidents", payload })).json();
    expect(second.id).toBe(first.id);
  });
});

describe("GET /incidents/:id", () => {
  it("returns the stored envelope", async () => {
    const { app, repository } = await build();
    const created = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    const res = await app.inject({ method: "GET", url: `/incidents/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(created.id);
  });

  it("returns 404 for an unknown id", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "GET",
      url: "/incidents/99999999-9999-9999-9999-999999999999",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("INCIDENT_NOT_FOUND");
  });

  it("returns 400 for a non-uuid id", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/incidents/not-a-uuid" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ID");
  });
});

describe("GET /incidents — filters + pagination", () => {
  async function seed(n: number) {
    const { app, repository } = await build();
    let clockTs = new Date("2026-05-29T10:00:00.000Z").getTime();
    for (let i = 0; i < n; i++) {
      await repository.create({
        airport_id: i % 2 === 0 ? AIRPORT : OTHER,
        severity: i % 3 === 0 ? "critical" : "high",
        title: `i-${i}`,
        now: () => new Date(clockTs++),
      });
    }
    return app;
  }

  it("returns paginated envelope with items + next_cursor", async () => {
    const app = await seed(5);
    const res = await app.inject({ method: "GET", url: "/incidents?limit=2" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
    expect(body.total).toBe(5);
  });

  it("filters by airport_id", async () => {
    const app = await seed(6);
    const res = await app.inject({ method: "GET", url: `/incidents?airport_id=${AIRPORT}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.every((i: { airport_id: string }) => i.airport_id === AIRPORT)).toBe(
      true,
    );
  });

  it("filters by severity", async () => {
    const app = await seed(6);
    const res = await app.inject({ method: "GET", url: `/incidents?severity=critical` });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.every((i: { severity: string }) => i.severity === "critical")).toBe(
      true,
    );
  });

  it("filters by status (e.g. only new)", async () => {
    const app = await seed(3);
    const res = await app.inject({ method: "GET", url: `/incidents?status=new` });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.every((i: { status: string }) => i.status === "new")).toBe(true);
  });

  it("paginates via cursor", async () => {
    const app = await seed(5);
    const first = (await app.inject({ method: "GET", url: "/incidents?limit=2" })).json();
    const second = (
      await app.inject({
        method: "GET",
        url: `/incidents?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
      })
    ).json();
    expect(second.items.map((i: { id: string }) => i.id)).not.toEqual(
      first.items.map((i: { id: string }) => i.id),
    );
  });

  it("returns 400 on bad query (e.g. limit > 200)", async () => {
    const app = await seed(0);
    const res = await app.inject({ method: "GET", url: "/incidents?limit=999" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on bad severity value", async () => {
    const app = await seed(0);
    const res = await app.inject({ method: "GET", url: "/incidents?severity=fatal" });
    expect(res.statusCode).toBe(400);
  });
});
