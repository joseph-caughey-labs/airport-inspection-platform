/**
 * Refresh-token revocation list (Phase 6 follow-up).
 *
 * The unit-level test surface is small on purpose — the interface
 * is just `revoke` + `isRevoked`. The interesting properties are
 * exercised at the api-gateway layer (`logout.test.ts` + the
 * existing `auth.test.ts`) where the list interacts with the
 * refresh route.
 */
import { describe, expect, it } from "vitest";
import { InMemoryRefreshTokenRevocationList } from "../../../packages/auth-jwt/src/revocation.js";

describe("InMemoryRefreshTokenRevocationList", () => {
  it("starts empty", async () => {
    const rl = new InMemoryRefreshTokenRevocationList();
    expect(rl.size).toBe(0);
    expect(await rl.isRevoked("some-token")).toBe(false);
  });

  it("revoke followed by isRevoked returns true", async () => {
    const rl = new InMemoryRefreshTokenRevocationList();
    await rl.revoke("refresh-token-1");
    expect(await rl.isRevoked("refresh-token-1")).toBe(true);
  });

  it("isRevoked returns false for any token NOT in the set", async () => {
    const rl = new InMemoryRefreshTokenRevocationList();
    await rl.revoke("refresh-token-1");
    expect(await rl.isRevoked("refresh-token-2")).toBe(false);
  });

  it("revoke is idempotent — calling twice doesn't double-count", async () => {
    const rl = new InMemoryRefreshTokenRevocationList();
    await rl.revoke("refresh-token-1");
    await rl.revoke("refresh-token-1");
    expect(rl.size).toBe(1);
  });

  it("size tracks distinct revoked tokens", async () => {
    const rl = new InMemoryRefreshTokenRevocationList();
    await rl.revoke("a");
    await rl.revoke("b");
    await rl.revoke("c");
    expect(rl.size).toBe(3);
  });
});
