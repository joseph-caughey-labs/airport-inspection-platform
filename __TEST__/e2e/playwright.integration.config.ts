import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Integration e2e config (T-507).
 *
 * Sibling to `playwright.config.ts` — same Chromium project, but
 * runs against the REAL dockerized stack rather than a Nuxt dev
 * server with mocked backends.
 *
 *   - testDir → `__TEST__/e2e/integration` (separate from the
 *     fixture-mocked `scenarios/` tier)
 *   - baseURL → `http://127.0.0.1:3000` by default (nginx-fronted
 *     compose port); override via `E2E_INTEGRATION_BASE_URL`
 *   - NO `webServer` block — the CI workflow `compose up`s the
 *     stack before invoking playwright. Locally, run
 *     `docker compose up -d` first and `pnpm e2e:integration`.
 *   - Longer timeouts than the mocked tier — Postgres/Redis/Nuxt
 *     SSR cold-start adds real seconds.
 *
 * Test surface stays small on purpose: this tier is for proving
 * the wires connect (login through nginx → api-gateway → JWT,
 * dashboard hydrates from reference-data, WS connects through
 * nginx → ws-broadcaster). The deep behavioural assertions stay
 * in the mocked tier where they're fast + deterministic.
 */
export default defineConfig({
  testDir: resolve(here, "integration"),
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  // Real services flake occasionally on Docker network jitter; one
  // retry absorbs the rough edges without masking real failures.
  retries: 1,
  workers: 1,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  use: {
    baseURL: process.env["E2E_INTEGRATION_BASE_URL"] ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    // The dockerized api-gateway uses self-signed certs nowhere yet,
    // but flip this on when TLS lands so dev workflows keep working.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium-integration",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
