/**
 * createJwtSigner tests (T-504).
 *
 * Pure tests of the JWT primitives — no Fastify, no fake clocks
 * unless the test specifically needs deterministic expiry.
 */
import { describe, expect, it } from "vitest";
import { AuthJwtError, createJwtSigner } from "../../../packages/auth-jwt/src/index.js";

const SECRET = "test-secret-must-be-at-least-32-bytes-long-thanks";

describe("createJwtSigner — sign + verify", () => {
  it("signs an access token, then verifies it back to the same claims", async () => {
    const signer = createJwtSigner({ secret: SECRET });
    const token = await signer.signAccess({
      user_id: "user-1",
      role: "operator",
    });
    expect(token.split(".")).toHaveLength(3); // JWT shape

    const verified = await signer.verifyAccess(token);
    expect(verified.kind).toBe("access");
    expect(verified.user_id).toBe("user-1");
    expect(verified.role).toBe("operator");
    expect(typeof verified.issued_at).toBe("number");
    expect(typeof verified.expires_at).toBe("number");
  });

  it("signs a refresh token + round-trips through verifyRefresh", async () => {
    const signer = createJwtSigner({ secret: SECRET });
    const token = await signer.signRefresh({ user_id: "user-1" });
    const verified = await signer.verifyRefresh(token);
    expect(verified.kind).toBe("refresh");
    expect(verified.user_id).toBe("user-1");
  });

  it("refuses an access token at verifyRefresh (wrong_kind)", async () => {
    const signer = createJwtSigner({ secret: SECRET });
    const access = await signer.signAccess({ user_id: "u", role: "operator" });
    await expect(signer.verifyRefresh(access)).rejects.toMatchObject({
      code: "wrong_kind",
    });
  });

  it("refuses a refresh token at verifyAccess (wrong_kind)", async () => {
    const signer = createJwtSigner({ secret: SECRET });
    const refresh = await signer.signRefresh({ user_id: "u" });
    await expect(signer.verifyAccess(refresh)).rejects.toMatchObject({
      code: "wrong_kind",
    });
  });

  it("rejects a tampered signature with invalid_token", async () => {
    const signer = createJwtSigner({ secret: SECRET });
    const token = await signer.signAccess({ user_id: "u", role: "operator" });
    const tampered = `${token.slice(0, -3)}AAA`;
    await expect(signer.verifyAccess(tampered)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const a = createJwtSigner({ secret: SECRET });
    const b = createJwtSigner({
      secret: "DIFFERENT-secret-also-at-least-32-bytes-long-okay",
    });
    const token = await a.signAccess({ user_id: "u", role: "operator" });
    await expect(b.verifyAccess(token)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rejects an expired token with expired_token", async () => {
    let now = Date.now();
    const signer = createJwtSigner({
      secret: SECRET,
      accessTtlSeconds: 60,
      now: () => now,
    });
    const token = await signer.signAccess({ user_id: "u", role: "operator" });
    now += 120_000; // skip 2 min
    await expect(signer.verifyAccess(token)).rejects.toMatchObject({
      code: "expired_token",
    });
  });

  it("rejects a token from a different issuer", async () => {
    const a = createJwtSigner({ secret: SECRET, issuer: "service-a" });
    const b = createJwtSigner({ secret: SECRET, issuer: "service-b" });
    const token = await a.signAccess({ user_id: "u", role: "operator" });
    await expect(b.verifyAccess(token)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("throws AuthJwtError on construction when the secret is too short", () => {
    expect(() => createJwtSigner({ secret: "too-short" })).toThrow(AuthJwtError);
  });
});
