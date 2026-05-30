/**
 * usePermission composable (T-504d).
 *
 * Thin reactive wrapper around `isAllowed` from
 * `@aip/shared-contracts`. The contract:
 *   - False for unauthenticated sessions.
 *   - Reflects the auth store's `role` and re-evaluates on changes.
 *   - Honours the policy matrix (operator can acknowledge, only
 *     reviewer/admin can archive, etc.).
 */
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { usePermission } from "~/composables/usePermission";
import { useAuthStore } from "~/stores/auth";

beforeEach(() => {
  setActivePinia(createPinia());
});

const PAT = {
  id: "33333333-1111-1111-1111-000000000001",
  email: "pat.operator@airport-ops.test",
  name: "Pat Operator",
  role: "operator" as const,
};

const RIO = {
  id: "33333333-1111-1111-1111-000000000002",
  email: "rio.reviewer@airport-ops.test",
  name: "Rio Reviewer",
  role: "reviewer" as const,
};

function loginAs(user: typeof PAT | typeof RIO): void {
  const auth = useAuthStore();
  auth.$patch({ accessToken: "test-token", refreshToken: "test-refresh", user });
}

describe("usePermission", () => {
  it("returns false when no user is signed in", () => {
    const can = usePermission("incident.read");
    expect(can.value).toBe(false);
  });

  it("returns true for an operator on an operator-allowed permission", () => {
    loginAs(PAT);
    expect(usePermission("incident.read").value).toBe(true);
    expect(usePermission("incident.acknowledge").value).toBe(true);
  });

  it("returns false for an operator on a reviewer-only permission", () => {
    loginAs(PAT);
    expect(usePermission("incident.archive").value).toBe(false);
    expect(usePermission("incident.reject").value).toBe(false);
    expect(usePermission("audit.verify").value).toBe(false);
  });

  it("returns true for a reviewer on reviewer-only permissions", () => {
    loginAs(RIO);
    expect(usePermission("incident.archive").value).toBe(true);
    expect(usePermission("incident.reject").value).toBe(true);
    expect(usePermission("audit.verify").value).toBe(true);
  });

  it("re-evaluates when the auth role changes (operator → reviewer)", () => {
    const auth = useAuthStore();
    const canArchive = usePermission("incident.archive");
    expect(canArchive.value).toBe(false);
    auth.$patch({ accessToken: "t", refreshToken: "r", user: PAT });
    expect(canArchive.value).toBe(false);
    auth.$patch({ user: RIO });
    expect(canArchive.value).toBe(true);
  });

  it("clears to false after logout", () => {
    loginAs(RIO);
    const auth = useAuthStore();
    const canArchive = usePermission("incident.archive");
    expect(canArchive.value).toBe(true);
    auth.logout();
    expect(canArchive.value).toBe(false);
  });
});
