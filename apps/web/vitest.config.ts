import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Frontend test scope: pure utility helpers only.
 *
 * The brief mandates a centralized `__TEST__/` directory above all
 * workspaces, but pnpm's strict isolation prevents test files there
 * from resolving `pinia` / `@vue/test-utils` (those live under
 * `apps/web/node_modules/`, not the workspace root). Component
 * coverage lands with **T-214 Playwright e2e**, where the test
 * runner is a separate process with its own deps.
 *
 * What runs here today: pure TypeScript helpers (zod schemas, geo
 * conversions, seed bundle factory) that don't touch Vue / Pinia /
 * Nuxt auto-imports. The `zod` alias below points at the apps/web
 * install so the centralized tests resolve it without depending on
 * pnpm hoist patterns.
 */
export default defineConfig({
  resolve: {
    alias: {
      "~": here,
      zod: resolve(here, "node_modules/zod"),
    },
  },
  test: {
    include: [resolve(here, "../../__TEST__/frontend/**/*.test.ts")],
    passWithNoTests: true,
  },
});
