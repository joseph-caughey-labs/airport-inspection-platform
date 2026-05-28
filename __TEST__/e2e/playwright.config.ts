import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const webAppDir = resolve(repoRoot, "apps/web");

/**
 * E2E config — exercises the real Nuxt dev server in Chromium and
 * intercepts the WebSocket via Playwright's `routeWebSocket` so the
 * scenario is deterministic in CI without any external services.
 *
 * `webServer` boots Nuxt dev on a stable port. CI installs Playwright
 * browsers via `pnpm e2e:install` (see .github/workflows/e2e.yml).
 *
 * Reuse the dev server if it's already running (local iteration);
 * otherwise spin one up fresh.
 */
export default defineConfig({
  testDir: resolve(here, "scenarios"),
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  // Nuxt dev server occasionally drops a connection between tests
  // (HMR transitions, Vite optimizer reruns). One retry absorbs it
  // without masking real failures — multiple retries would.
  retries: 1,
  workers: 1,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm --filter @aip/web dev",
    cwd: repoRoot,
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Force-disable telemetry + listen on the loopback we baseURL against.
      NUXT_TELEMETRY_DISABLED: "1",
      NITRO_PORT: "3000",
      HOST: "127.0.0.1",
      // Surface to the running app that we're in test mode (lets us
      // bypass things like the welcome modal if we add one).
      NUXT_PUBLIC_E2E_MODE: "1",
    },
  },
  // Make the webAppDir reachable via the project meta (used by helpers).
  metadata: { webAppDir },
});
