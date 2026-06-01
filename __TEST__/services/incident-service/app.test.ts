import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/incident-service/src/app.js";
import { bearer, makeTestSigner, operatorToken } from "../../helpers/auth.js";

const logger = createLogger({ service: "incident-service-test", level: "fatal" });

function healthyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })),
  } as unknown as import("pg").Pool;
}

describe("incident-service — shell", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let auth: { authorization: string };
  beforeAll(async () => {
    const signer = makeTestSigner();
    app = await buildApp({ logger, pool: healthyPool(), signer });
    auth = bearer(await operatorToken(signer));
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200 ok (public, no auth required)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /ready returns 200 when Postgres is up (public, no auth required)", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });

  it("GET /incidents returns 401 without an access token", async () => {
    const res = await app.inject({ method: "GET", url: "/incidents" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /incidents returns the canonical paginated envelope when authenticated", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/incidents",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    // Behavior tested in detail in __TEST__/api/rest/incidents/.
    expect(res.json()).toEqual({ items: [], next_cursor: null, total: 0 });
  });
});
