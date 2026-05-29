import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: [
      resolve(here, "../../__TEST__/services/incident-service/**/*.test.ts"),
      // Domain-layer lifecycle tests (T-401). Kept under the shared
      // __TEST__/unit/ tree so they're discoverable architecturally.
      resolve(here, "../../__TEST__/unit/incident-lifecycle/**/*.test.ts"),
    ],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
