/**
 * Security regression suite — cross-service RBAC enforcement (T-514).
 *
 * The gateway is not the only authz boundary: every backend service
 * verifies the JWT and applies its own per-route `requireRole` keyed
 * off the shared `PERMISSION_POLICY`. That "don't trust the gateway,
 * verify locally" posture is what stops a leaked or forged token from
 * walking straight into a downstream service.
 *
 * incident-service is the richest RBAC surface (10 protected routes,
 * two of them review-only), so it stands in for the pattern every
 * service shares via `@aip/auth-jwt`. The matrix here proves three
 * properties:
 *
 *   1. No token  → 401 on EVERY protected route (deny-by-default).
 *   2. Wrong role → 403 on the review-only routes (archive / reject)
 *      that an operator must not reach — the privilege boundary.
 *   3. Forged token (signed with a foreign secret) → 401, proving the
 *      service verifies signatures itself rather than trusting an
 *      upstream hop.
 *
 * The allowed-role happy path is covered structurally in
 * `__TEST__/services/incident-service/app.test.ts`; here we assert the
 * *negative* space the behavioural suite doesn't.
 */
import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/incident-service/src/app.js";
import {
  adminToken,
  bearer,
  makeTestSigner,
  operatorToken,
  reviewerToken,
} from "../../helpers/auth.js";

const logger = createLogger({ service: "incident-service-security-test", level: "fatal" });

/** `/ready` is the only route that touches the pool; a stub that
 * answers the health probe is all the RBAC matrix needs. */
function healthyPool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })),
  } as unknown as import("pg").Pool;
}

// A valid-shaped UUID so the path passes the `:id` format check and the
// request reaches the RBAC preHandler / route body (not a 400 on the id
// itself). The incident doesn't exist — irrelevant: authz runs first.
const SOME_ID = "11111111-1111-1111-1111-111111111111";

// The protected route table, mirrored from `registerIncidentRoutes`.
// `minRole` documents the lowest-privilege role the policy admits.
const PROTECTED_ROUTES: Array<{ method: "GET" | "POST"; url: string; reviewOnly: boolean }> = [
  { method: "GET", url: "/incidents", reviewOnly: false },
  { method: "GET", url: `/incidents/${SOME_ID}`, reviewOnly: false },
  { method: "POST", url: "/incidents", reviewOnly: false },
  { method: "POST", url: `/incidents/${SOME_ID}/acknowledge`, reviewOnly: false },
  { method: "POST", url: `/incidents/${SOME_ID}/assign`, reviewOnly: false },
  { method: "POST", url: `/incidents/${SOME_ID}/start_progress`, reviewOnly: false },
  { method: "POST", url: `/incidents/${SOME_ID}/resolve`, reviewOnly: false },
  { method: "POST", url: `/incidents/${SOME_ID}/escalate`, reviewOnly: false },
  { method: "POST", url: `/incidents/${SOME_ID}/archive`, reviewOnly: true },
  { method: "POST", url: `/incidents/${SOME_ID}/reject`, reviewOnly: true },
];

describe("incident-service security — deny-by-default (no token → 401)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger, pool: healthyPool(), signer: makeTestSigner() });
  });
  afterAll(async () => {
    await app.close();
  });

  for (const route of PROTECTED_ROUTES) {
    it(`${route.method} ${route.url} → 401 without a token`, async () => {
      const res = await app.inject({ method: route.method, url: route.url, payload: {} });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe("unauthorized");
    });
  }
});

describe("incident-service security — the operator/reviewer privilege boundary", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let signer: ReturnType<typeof makeTestSigner>;
  beforeAll(async () => {
    signer = makeTestSigner();
    app = await buildApp({ logger, pool: healthyPool(), signer });
  });
  afterAll(async () => {
    await app.close();
  });

  // archive + reject are gated on `incident.archive` / `incident.reject`,
  // both reviewer-only in PERMISSION_POLICY. An operator carrying a
  // perfectly valid token must still be turned away at 403.
  const reviewOnly = PROTECTED_ROUTES.filter((r) => r.reviewOnly);

  for (const route of reviewOnly) {
    it(`operator is FORBIDDEN (403) on ${route.url}`, async () => {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: bearer(await operatorToken(signer)),
        payload: { operator_id: "00000000-0000-0000-0000-0000000000aa" },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
    });

    it(`reviewer clears the RBAC guard on ${route.url} (not 401/403)`, async () => {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: bearer(await reviewerToken(signer)),
        payload: { operator_id: "00000000-0000-0000-0000-0000000000bb" },
      });
      // Past the guard: the incident doesn't exist, so a 404 (or a 400
      // on the body) is fine — the point is authz did NOT reject it.
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });

    it(`admin clears the RBAC guard on ${route.url} (not 401/403)`, async () => {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: bearer(await adminToken(signer)),
        payload: { operator_id: "00000000-0000-0000-0000-0000000000cc" },
      });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });
  }

  it("operator reaches a read route it IS permitted for (200)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/incidents",
      headers: bearer(await operatorToken(signer)),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("incident-service security — the service verifies tokens itself", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger, pool: healthyPool(), signer: makeTestSigner() });
  });
  afterAll(async () => {
    await app.close();
  });

  it("a token forged with a foreign secret is rejected with 401, not trusted", async () => {
    // Same issuer, same claims, valid shape — but signed with a secret
    // the service has never seen. If incident-service trusted the
    // gateway instead of verifying, this would sail through. It must 401.
    const forger = createJwtSigner({
      secret: "a-totally-different-secret-32-bytes-minimum-for-real",
      issuer: "aip-api-gateway",
    });
    const forged = await forger.signAccess({
      user_id: "00000000-0000-0000-0000-00000000dead",
      role: "reviewer",
    });
    const res = await app.inject({
      method: "GET",
      url: "/incidents",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
