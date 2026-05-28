import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Frontend test scope is intentionally empty in Phase 1.
 *
 * Why: the brief mandates a centralized `__TEST__/` directory above all
 * workspaces, but pnpm's strict isolation prevents test files there
 * from resolving `pinia` / `@vue/test-utils` / etc. (those packages
 * live under `apps/web/node_modules/`, not the workspace root).
 *
 * Component coverage lands with **T-214 Playwright e2e**, where the
 * test runner is a separate process with its own deps and the
 * isolation problem doesn't apply. Until then, the operator shell is
 * verified by:
 *  - typecheck (vue-tsc / nuxt typecheck) — catches type errors.
 *  - lint (eslint) — catches obvious bugs.
 *  - manual `pnpm --filter @aip/web dev` smoke during PR review.
 */
export default defineConfig({
  resolve: {
    alias: { "~": here },
  },
  test: {
    include: [resolve(here, "../../__TEST__/frontend/**/*.test.ts")],
    // T-214 brings real coverage; until then the directory is intentionally empty.
    passWithNoTests: true,
  },
});
