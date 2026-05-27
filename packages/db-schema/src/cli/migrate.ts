#!/usr/bin/env node
/**
 * CLI entrypoint for migrations. Wires env vars → pool → runMigrations.
 * Invoke via `pnpm db:migrate` at the workspace root.
 */
import { createPgPool } from "@aip/postgres-client";
import { runMigrations } from "../migrate.js";

async function main(): Promise<void> {
  const pool = createPgPool({
    host: process.env["POSTGRES_HOST"] ?? "localhost",
    port: Number(process.env["POSTGRES_PORT"] ?? 5432),
    user: process.env["POSTGRES_USER"] ?? "airport_ops",
    password: process.env["POSTGRES_PASSWORD"] ?? "",
    database: process.env["POSTGRES_DB"] ?? "airport_inspection",
  });

  try {
    const result = await runMigrations(pool);
    if (result.applied.length === 0 && result.skipped.length === 0) {
      console.warn("[db:migrate] no migrations on disk");
    }
    for (const name of result.applied) {
      console.warn(`[db:migrate] applied: ${name}`);
    }
    for (const name of result.skipped) {
      console.warn(`[db:migrate] skipped (already applied): ${name}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[db:migrate] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
