/**
 * `POST /api/v1/auth/logout` route tests (Phase 6 follow-up).
 *
 * Pinned properties:
 *   - The auth.logout security event fires with the right actor.
 *   - The refresh token is added to the revocation list.
 *   - A subsequent refresh of the same token now returns 401
 *     with reason=revoked (proves the refresh path also checks
 *     the list, not just logout).
 *   - Idempotent: logging out the same token twice doesn't error.
 *   - Malformed/expired tokens 401 cleanly without emitting an
 *     `auth.logout` event for a null actor.
 *   - Schema-validation rejection on a missing refresh_token
 *     returns 400, not 401.
 */
import { createJwtSigner, InMemoryRefreshTokenRevocationList } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordingSecurityEventPublisher } from "../../../packages/security-events/src/index.js";
import { buildApp } from "../../../services/api-gateway/src/app.js";
import { createInMemoryDirectory } from "../../../services/api-gateway/src/auth/directory.js";

const logger = createLogger({ service: "logout-test", level: "fatal" });
const SECRET = "test-only-secret-do-not-use-in-prod-32-bytes-minimum-thanks";

const OPERATOR_EMAIL = "pat.operator@airport-ops.test";

let app: Awaited<ReturnType<typeof buildApp>>;
let recorder: RecordingSecurityEventPublisher;
let revocationList: InMemoryRefreshTokenRevocationList;

beforeEach(async () => {
  recorder = new RecordingSecurityEventPublisher();
  revocationList = new InMemoryRefreshTokenRevocationList();
  app = await buildApp({
    logger,
    registry: createRegistry({ service: "logout-test", collectDefault: false }),
    signer: createJwtSigner({ secret: SECRET, issuer: "aip-api-gateway" }),
    directory: createInMemoryDirectory(),
    securityEvents: recorder,
    revocationList,
    rateLimitDisabled: true,
  });
});

afterEach(async () => {
  await app.close();
});

async function loginForRefresh(): Promise<{ refreshToken: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: OPERATOR_EMAIL },
  });
  const body = res.json() as {
    refresh_token: string;
    user: { id: string };
  };
  return { refreshToken: body.refresh_token, userId: body.user.id };
}

describe("POST /api/v1/auth/logout — happy path", () => {
  it("revokes the refresh token and emits auth.logout with the user id", async () => {
    const { refreshToken, userId } = await loginForRefresh();
    recorder.published.length = 0; // discard the login event

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refresh_token: refreshToken },
    });
    expect(res.statusCode).toBe(204);

    // Audit
    const logouts = recorder.published.filter((e) => e.event_type === "auth.logout");
    expect(logouts).toHaveLength(1);
    expect(logouts[0]!.actor_user_id).toBe(userId);

    // Revocation
    expect(await revocationList.isRevoked(refreshToken)).toBe(true);
  });

  it("a subsequent /auth/refresh of the same token returns 401 with reason=revoked", async () => {
    const { refreshToken } = await loginForRefresh();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refresh_token: refreshToken },
    });
    recorder.published.length = 0;

    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    const failed = recorder.published.filter((e) => e.event_type === "auth.refresh.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ reason: "revoked" });
  });

  it("is idempotent — calling logout twice on the same token still returns 204", async () => {
    const { refreshToken } = await loginForRefresh();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refresh_token: refreshToken },
    });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refresh_token: refreshToken },
    });
    expect(second.statusCode).toBe(204);
  });
});

describe("POST /api/v1/auth/logout — rejection paths", () => {
  it("returns 400 when refresh_token is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 on a malformed refresh token and does NOT emit auth.logout", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refresh_token: "not-a-real-jwt" },
    });
    expect(res.statusCode).toBe(401);
    expect(recorder.published.filter((e) => e.event_type === "auth.logout")).toHaveLength(0);
  });

  it("returns 401 when an access token (wrong_kind) is sent in place of a refresh token", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: OPERATOR_EMAIL },
    });
    const { access_token } = login.json() as { access_token: string };
    recorder.published.length = 0;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refresh_token: access_token },
    });
    expect(res.statusCode).toBe(401);
    expect(recorder.published.filter((e) => e.event_type === "auth.logout")).toHaveLength(0);
  });
});
