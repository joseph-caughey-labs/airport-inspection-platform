/**
 * /api/v1/auth/login + /api/v1/auth/refresh tests (T-504).
 *
 * Drives the api-gateway app via Fastify inject — confirms the full
 * login → refresh → ping authentication chain works end-to-end with
 * the real JWT signer + the seeded in-memory directory.
 */
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../services/api-gateway/src/app.js";

const logger = createLogger({ service: "auth-test", level: "fatal" });

describe("api-gateway — POST /api/v1/auth/login", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({
      logger,
      registry: createRegistry({ service: "auth-test", collectDefault: false }),
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("issues access + refresh tokens for a seeded operator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pat.operator@airport-ops.test" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      access_token: string;
      refresh_token: string;
      user: { id: string; email: string; name: string; role: string };
    };
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(body.refresh_token.split(".")).toHaveLength(3);
    expect(body.user.role).toBe("operator");
    expect(body.user.email).toBe("pat.operator@airport-ops.test");
  });

  it("issues a reviewer token for the reviewer seed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "rio.reviewer@airport-ops.test" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { role: string } }).user.role).toBe("reviewer");
  });

  it("issues an admin token for the admin seed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alex.admin@airport-ops.test" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { role: string } }).user.role).toBe("admin");
  });

  it("normalizes email case before lookup", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "PAT.OPERATOR@AIRPORT-OPS.TEST" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 401 unauthorized for an unknown email (no disclosure)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    // Message MUST NOT confirm the email's existence either way.
    expect(body.error.message).toBe("invalid credentials");
  });

  it("returns 400 validation_failed when email is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_failed");
  });
});

describe("api-gateway — POST /api/v1/auth/refresh", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({
      logger,
      registry: createRegistry({ service: "auth-test", collectDefault: false }),
    });
  });
  afterAll(async () => {
    await app.close();
  });

  async function loginAndGetTokens() {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pat.operator@airport-ops.test" },
    });
    return res.json() as { access_token: string; refresh_token: string };
  }

  it("issues a fresh access token given a valid refresh token", async () => {
    const { refresh_token } = await loginAndGetTokens();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { access_token: string };
    expect(body.access_token.split(".")).toHaveLength(3);
  });

  it("rejects an access token used as a refresh token", async () => {
    const { access_token } = await loginAndGetTokens();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: access_token },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { details: { code: string } } }).error.details.code).toBe(
      "wrong_kind",
    );
  });

  it("rejects a malformed refresh token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: "not.a.real.token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when refresh_token is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("api-gateway — RBAC (requireAuth + requireRole)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({
      logger,
      registry: createRegistry({ service: "auth-test", collectDefault: false }),
    });
  });
  afterAll(async () => {
    await app.close();
  });

  async function tokenFor(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email },
    });
    return (res.json() as { access_token: string }).access_token;
  }

  it("requireAuth: rejects unauthenticated requests with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/whoami" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("requireAuth: accepts any role with a valid token", async () => {
    const token = await tokenFor("pat.operator@airport-ops.test");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/whoami",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user_id: string; role: string };
    expect(body.role).toBe("operator");
    expect(body.user_id).toBe("33333333-1111-1111-1111-000000000001");
  });

  it("requireRole(admin): rejects operator with 403", async () => {
    const token = await tokenFor("pat.operator@airport-ops.test");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/echo",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string; details: { required: string[] } } };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details.required).toContain("admin");
  });

  it("requireRole(admin): rejects reviewer with 403", async () => {
    const token = await tokenFor("rio.reviewer@airport-ops.test");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/echo",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requireRole(admin): accepts admin with 200", async () => {
    const token = await tokenFor("alex.admin@airport-ops.test");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/echo",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { admin: string }).admin).toBe("33333333-1111-1111-1111-000000000003");
  });

  it("requireRole(admin) with no auth header: rejects with 401, not 403", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/echo" });
    expect(res.statusCode).toBe(401);
  });
});
