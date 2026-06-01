import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.turbo/**",
      "**/.nuxt/**",
      "**/.output/**",
      "**/coverage/**",
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // T-501: structured logging — `console.log` is unstructured and
      // bypasses `@aip/logger`'s context propagation + redaction. Bump
      // from warn → error so a new console.log fails CI rather than
      // sneaking through. `console.error` is still allowed because
      // bootstrap failures in main.ts fire before any logger is up
      // and the catch-all must produce SOME output.
      "no-console": ["error", { allow: ["error"] }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
    },
  },
  {
    // CLI tools are the operator-facing surface; structured logs
    // would be worse UX than plain console output. `db:migrate` /
    // `db:seed` keep console freedom.
    files: ["packages/db-schema/src/cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
