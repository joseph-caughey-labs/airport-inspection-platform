import { defineConfig } from "vitest/config";

/**
 * Load-suite runner config (T-513).
 *
 * This config is INTENTIONALLY isolated from the per-service vitest
 * projects: the load scenarios drive the live docker-compose stack and
 * take minutes, so they must never run in the per-PR `turbo run test`
 * fan-out. They run only via `pnpm --filter @aip/load-tests test:load`
 * (or the root `pnpm test:load`) against a stack you brought up
 * yourself. With no stack reachable, every scenario skips cleanly (see
 * `src/harness/stack.ts`) rather than failing — so an accidental
 * invocation is harmless.
 */
export default defineConfig({
  test: {
    include: ["scenarios/**/*.scenario.ts"],
    globals: false,
    // Scenarios mutate one shared stack (publishing load, stopping
    // containers); they must not overlap. One fork, no file parallelism.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Load runs + container restarts are slow. Generous ceilings.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // A flaky load assertion should fail loudly, not be papered over.
    retry: 0,
    reporters: ["verbose"],
  },
});
