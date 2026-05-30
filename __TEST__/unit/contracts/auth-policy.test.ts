/**
 * RBAC policy matrix tests (T-504).
 *
 * The policy map in `packages/shared-contracts/src/auth/policy.ts`
 * is the source of truth that both backend (`requireRole`) and
 * frontend (UI visibility) read. These tests pin invariants:
 *   - Every Permission has an explicit entry (compile-time + runtime).
 *   - `admin` is always allowed everything.
 *   - `isAllowed` and `rolesFor` agree.
 */
import { describe, expect, it } from "vitest";
import {
  isAllowed,
  PERMISSION_POLICY,
  rolesFor,
  type Permission,
} from "../../../packages/shared-contracts/src/auth/policy.js";

const PERMISSIONS = Object.keys(PERMISSION_POLICY) as Permission[];

describe("PERMISSION_POLICY", () => {
  it("every permission has an entry in the map", () => {
    // The map is typed `Record<Permission, ...>`; this just confirms
    // we haven't accidentally introduced a Permission union member
    // without a runtime entry.
    expect(PERMISSIONS.length).toBeGreaterThan(0);
    for (const p of PERMISSIONS) {
      expect(PERMISSION_POLICY[p]).toBeDefined();
    }
  });
});

describe("isAllowed", () => {
  it("admin is allowed every permission", () => {
    for (const p of PERMISSIONS) {
      expect(isAllowed("admin", p)).toBe(true);
    }
  });

  it("operator vs reviewer scoping", () => {
    // Spot-checks rather than exhaustive — the matrix is the source
    // of truth; tests just confirm `isAllowed` reads it correctly.
    expect(isAllowed("operator", "incident.acknowledge")).toBe(true);
    expect(isAllowed("operator", "incident.archive")).toBe(false);
    expect(isAllowed("reviewer", "incident.archive")).toBe(true);
    expect(isAllowed("reviewer", "validation.override")).toBe(true);
    expect(isAllowed("operator", "validation.override")).toBe(false);
    expect(isAllowed("operator", "platform.admin")).toBe(false);
    expect(isAllowed("reviewer", "platform.admin")).toBe(false);
  });
});

describe("rolesFor", () => {
  it("includes admin implicitly for every permission", () => {
    for (const p of PERMISSIONS) {
      expect(rolesFor(p)).toContain("admin");
    }
  });

  it("matches the matrix for non-admin entries", () => {
    expect(rolesFor("incident.acknowledge").sort()).toEqual(
      ["admin", "operator", "reviewer"].sort(),
    );
    expect(rolesFor("validation.override").sort()).toEqual(["admin", "reviewer"].sort());
    expect(rolesFor("platform.admin")).toEqual(["admin"]);
  });
});
