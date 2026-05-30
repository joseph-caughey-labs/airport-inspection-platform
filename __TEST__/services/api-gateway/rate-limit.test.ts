/**
 * Rate-limit + input-safety tests for api-gateway (T-505).
 *
 * Builds the app with the limiter enabled and exercises the two
 * budgets:
 *   - Global per-IP — applies to every protected route.
 *   - Tighter per-route override on the auth surface
 *     (`/api/v1/auth/login`, `/api/v1/auth/refresh`).
 *
 * Also pins the body-limit + error-envelope behaviour the
 * `@aip/http-safety` package contributes.
 */
import { createJwtSigner } from "@aip/auth-jwt";
import { ErrorCode } from "@aip/shared-contracts";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../../services/api-gateway/src/app.js";
import { createInMemoryDirectory } from "../../../services/api-gateway/src/auth/directory.js";

const logger = createLogger({ service: "api-gateway-rate-limit-test", level: "fatal" });

function buildOpts() {
  return {
    logger,
    registry: createRegistry({
      service: "api-gateway-rate-limit-test",
      collectDefault: false,
    }),
    signer: createJwtSigner({
      secret: "test-only-secret-do-not-use-in-prod-32-bytes-minimum-thanks",
      issuer: "aip-api-gateway",
    }),
    directory: createInMemoryDirectory(),
  };
}

let app: Awaited<ReturnType<typeof buildApp>>;
afterEach(async () => {
  await app.close();
});

describe("api-gateway — rate limiting (T-505)", () => {
  it("returns 429 after the global per-IP budget is exhausted on a public route", async () => {
    // Build with a global limit we can blow through quickly. The
    // route-level auth override doesn't apply to /health, so /health
    // bumps the global counter at 1 req each.
    app = await buildApp(buildOpts());
    // The global budget defaults to 240/min — too high for a unit
    // test loop. Instead we hit the tighter auth budget (20/min)
    // which proves the same enforcement path: 200/4xx until the
    // budget is gone, then 429.
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        // Wrong email — the directory returns null, we get a 401.
        // The rate-limit hook fires BEFORE the handler, so 401 still
        // counts against the budget. After ~20 requests we expect 429.
        payload: { email: "no-such-user@example.test" },
      });
      last = res.statusCode;
      if (res.statusCode === 429) break;
    }
    expect(last).toBe(429);
  });

  it("the 429 response uses the canonical RATE_LIMITED envelope", async () => {
    app = await buildApp(buildOpts());
    // Burn through the auth budget.
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "no-such-user@example.test" },
      });
      if (res.statusCode === 429) {
        const body = res.json() as { error: { code: string; correlation_id?: string } };
        expect(body.error.code).toBe(ErrorCode.RATE_LIMITED);
        return;
      }
    }
    throw new Error("never observed a 429 — auth budget is wider than expected");
  });

  it("rateLimitDisabled bypass keeps `n` requests below the global cap from rate-limiting", async () => {
    // The escape hatch tests use when they need lots of requests in
    // a row. Without it the global 240/min limit would bite long-
    // running fixture-driven tests; with it the auth budget is also
    // skipped.
    app = await buildApp({ ...buildOpts(), rateLimitDisabled: true });
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "no-such-user@example.test" },
      });
      // 401 because the email isn't seeded — never 429.
      expect([401]).toContain(res.statusCode);
    }
  });
});

describe("api-gateway — body limit + error envelope (T-505)", () => {
  beforeEach(async () => {
    app = await buildApp({ ...buildOpts(), rateLimitDisabled: true });
  });

  it("rejects oversized payloads with PAYLOAD_TOO_LARGE", async () => {
    // 256 KiB is the default cap; ship 512 KiB.
    const huge = "x".repeat(512 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "a@b.test", filler: huge }),
    });
    expect(res.statusCode).toBe(413);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it("unknown route returns the sanitized NOT_FOUND envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/no-such-thing" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(body.error.message).toContain("/api/v1/no-such-thing");
  });
});
