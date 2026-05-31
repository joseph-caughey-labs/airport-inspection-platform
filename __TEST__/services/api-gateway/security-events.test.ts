/**
 * Security-event emission tests for api-gateway (T-506).
 *
 * Builds the app with a recording publisher and asserts the exact
 * envelope shape every emit-site produces. The publisher is
 * injected via `securityEvents` so we don't need a real Redis.
 */
import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../../services/api-gateway/src/app.js";
import { createInMemoryDirectory } from "../../../services/api-gateway/src/auth/directory.js";
import {
  RecordingSecurityEventPublisher,
  type SecurityEvent,
} from "../../../packages/security-events/src/index.js";

const logger = createLogger({ service: "security-events-test", level: "fatal" });
const SECRET = "test-only-secret-do-not-use-in-prod-32-bytes-minimum-thanks";

let app: Awaited<ReturnType<typeof buildApp>>;
let recorder: RecordingSecurityEventPublisher;

beforeEach(async () => {
  recorder = new RecordingSecurityEventPublisher();
  app = await buildApp({
    logger,
    registry: createRegistry({ service: "security-events-test", collectDefault: false }),
    signer: createJwtSigner({ secret: SECRET, issuer: "aip-api-gateway" }),
    directory: createInMemoryDirectory(),
    securityEvents: recorder,
    // Rate limiter off so we can hit auth-fail twice without
    // colliding with the 20/min budget — this is the
    // documented bypass.
    rateLimitDisabled: true,
  });
});

afterEach(async () => {
  await app.close();
});

function only(events: SecurityEvent[], type: SecurityEvent["event_type"]): SecurityEvent[] {
  return events.filter((e) => e.event_type === type);
}

describe("auth.login.succeeded + auth.login.failed emission", () => {
  it("emits auth.login.succeeded with the user id + role on a successful seed login", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pat.operator@airport-ops.test" },
    });
    expect(res.statusCode).toBe(200);

    const ok = only(recorder.published, "auth.login.succeeded");
    expect(ok).toHaveLength(1);
    expect(ok[0]!.source).toEqual({ service: "api-gateway" });
    expect(ok[0]!.actor_user_id).toBe("33333333-1111-1111-1111-000000000001");
    expect(ok[0]!.subject_id).toBe("33333333-1111-1111-1111-000000000001");
    expect(ok[0]!.payload).toMatchObject({
      email: "pat.operator@airport-ops.test",
      role: "operator",
    });
  });

  it("emits auth.login.failed with null actor + the email + reason for an unknown user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.test" },
    });
    expect(res.statusCode).toBe(401);

    const fail = only(recorder.published, "auth.login.failed");
    expect(fail).toHaveLength(1);
    expect(fail[0]!.actor_user_id).toBeNull();
    expect(fail[0]!.subject_id).toBeNull();
    expect(fail[0]!.payload).toMatchObject({
      email: "nobody@example.test",
      reason: "no_such_user",
    });
  });

  it("does NOT emit a security event when the login body fails schema validation", async () => {
    // 400 is a client error but not a security signal — no event.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { not_an_email: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(recorder.published).toHaveLength(0);
  });
});

describe("auth.refresh.succeeded + auth.refresh.failed emission", () => {
  async function loginAndPluckRefresh(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pat.operator@airport-ops.test" },
    });
    return (res.json() as { refresh_token: string }).refresh_token;
  }

  it("emits auth.refresh.succeeded with the user id on a valid refresh", async () => {
    const refreshToken = await loginAndPluckRefresh();
    recorder.published.length = 0; // drop login event

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: refreshToken },
    });
    expect(res.statusCode).toBe(200);

    const ok = only(recorder.published, "auth.refresh.succeeded");
    expect(ok).toHaveLength(1);
    expect(ok[0]!.actor_user_id).toBe("33333333-1111-1111-1111-000000000001");
  });

  it("emits auth.refresh.failed with the AuthJwtError code on an invalid refresh token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: "not-a-real-jwt" },
    });
    expect(res.statusCode).toBe(401);

    const fail = only(recorder.published, "auth.refresh.failed");
    expect(fail).toHaveLength(1);
    expect(fail[0]!.actor_user_id).toBeNull();
    expect(fail[0]!.payload).toMatchObject({ reason: "invalid_token" });
  });
});

describe("access.denied emission via onResponse hook", () => {
  it("emits access.denied with status=401 when /api/v1/whoami is hit without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/whoami" });
    expect(res.statusCode).toBe(401);

    const denied = only(recorder.published, "access.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({
      route: "/api/v1/whoami",
      method: "get",
      status: 401,
    });
    expect(denied[0]!.actor_user_id).toBeNull();
  });

  it("emits access.denied with status=403 + the role when an operator hits an admin-only route", async () => {
    // Log in as an operator, then hit /api/v1/admin/echo (admin-only).
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pat.operator@airport-ops.test" },
    });
    const accessToken = (login.json() as { access_token: string }).access_token;
    recorder.published.length = 0;

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/echo",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);

    const denied = only(recorder.published, "access.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({
      route: "/api/v1/admin/echo",
      method: "get",
      status: 403,
      actual_role: "operator",
    });
    expect(denied[0]!.actor_user_id).toBe("33333333-1111-1111-1111-000000000001");
  });

  it("does NOT emit access.denied for 401s on the auth routes (they emit auth.* instead)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.test" },
    });
    expect(res.statusCode).toBe(401);
    expect(only(recorder.published, "access.denied")).toHaveLength(0);
    expect(only(recorder.published, "auth.login.failed")).toHaveLength(1);
  });
});

describe("rate_limit.blocked emission via onExceeded", () => {
  it("emits rate_limit.blocked when the auth budget is exhausted", async () => {
    // Rebuild the app with the limiter ON so we can blow through
    // the 20/min auth budget.
    await app.close();
    recorder = new RecordingSecurityEventPublisher();
    app = await buildApp({
      logger,
      registry: createRegistry({ service: "security-events-test", collectDefault: false }),
      signer: createJwtSigner({ secret: SECRET, issuer: "aip-api-gateway" }),
      directory: createInMemoryDirectory(),
      securityEvents: recorder,
    });
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "nobody@example.test" },
      });
      if (res.statusCode === 429) break;
    }
    const blocked = only(recorder.published, "rate_limit.blocked");
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]!.payload).toMatchObject({
      route: "/api/v1/auth/login",
      method: "post",
    });
    expect(blocked[0]!.payload).toHaveProperty("budget_per_minute");
  });
});
