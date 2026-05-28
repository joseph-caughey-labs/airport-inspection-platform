#!/usr/bin/env node
/**
 * CLI entrypoint for seeding. Wires env vars → pool → seedFromJson.
 * Invoke via `pnpm db:seed` at the workspace root.
 */
import { createPgPool } from "@aip/postgres-client";
import { seedFromJson } from "../seed.js";

async function main(): Promise<void> {
  const pool = createPgPool({
    host: process.env["POSTGRES_HOST"] ?? "localhost",
    port: Number(process.env["POSTGRES_PORT"] ?? 5432),
    user: process.env["POSTGRES_USER"] ?? "airport_ops",
    password: process.env["POSTGRES_PASSWORD"] ?? "",
    database: process.env["POSTGRES_DB"] ?? "airport_inspection",
  });

  try {
    const result = await seedFromJson(pool);
    console.warn(
      `[db:seed] inserted: airports=${result.airports}, runways=${result.runways}, ` +
        `sensors=${result.sensors}, users=${result.users}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[db:seed] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
