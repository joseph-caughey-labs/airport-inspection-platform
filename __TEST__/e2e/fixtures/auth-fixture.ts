import type { Page } from "@playwright/test";

/**
 * Pre-seed an authenticated session for Playwright specs (T-504d).
 *
 * The global `auth.global.ts` middleware redirects unauthenticated
 * traffic to `/login`, so every e2e spec that navigates straight to
 * an app route needs auth state in `localStorage` before the SPA
 * boots. We use `addInitScript` so the script runs in every page
 * context BEFORE any application JS — including the auth-restore
 * plugin that reads the same key.
 *
 * The token is a non-empty string so `isAuthenticated` flips true;
 * it isn't a real JWT. The existing scenarios mock backend calls via
 * `page.route` and never send a real Authorization header through to
 * the server, so a synthetic token is fine. Specs that exercise the
 * actual JWT flow would call `auth.login(email)` against a stubbed
 * `/api/v1/auth/login` instead.
 *
 * Roles map onto the seeded directory the api-gateway uses; default
 * is `operator` since that's what most flows need.
 */
export interface SeedAuthOptions {
  role?: "operator" | "reviewer" | "admin";
}

const STORAGE_KEY = "aip.auth.v1";

const SEEDED_USERS = {
  operator: {
    id: "33333333-1111-1111-1111-000000000001",
    email: "pat.operator@airport-ops.test",
    name: "Pat Operator",
    role: "operator" as const,
  },
  reviewer: {
    id: "33333333-1111-1111-1111-000000000002",
    email: "rio.reviewer@airport-ops.test",
    name: "Rio Reviewer",
    role: "reviewer" as const,
  },
  admin: {
    id: "33333333-1111-1111-1111-000000000003",
    email: "alex.admin@airport-ops.test",
    name: "Alex Admin",
    role: "admin" as const,
  },
};

export async function seedAuth(page: Page, opts: SeedAuthOptions = {}): Promise<void> {
  const user = SEEDED_USERS[opts.role ?? "operator"];
  const payload = {
    accessToken: "e2e-test-access-token",
    refreshToken: "e2e-test-refresh-token",
    user,
  };
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: STORAGE_KEY, value: JSON.stringify(payload) },
  );
}
