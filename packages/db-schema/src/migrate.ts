import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withTransaction, type PgPool } from "@aip/postgres-client";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(here, "./migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

interface MigrationsRunnerOptions {
  /** Override the migrations directory (mostly for tests). */
  migrationsDir?: string;
}

/**
 * Run all pending SQL migrations against `pool`. Idempotent — already
 * applied migrations are skipped via the `_schema_migrations` ledger.
 *
 * Each migration's content is hashed (sha256); a mismatch between the
 * stored hash and the on-disk file aborts the run with a typed error
 * (a migration has been edited in place — never edit a landed
 * migration; create a new one).
 */
export async function runMigrations(
  pool: PgPool,
  opts: MigrationsRunnerOptions = {},
): Promise<MigrationResult> {
  const migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      name        text PRIMARY KEY,
      sha256      char(64) NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of files) {
    const path = resolve(migrationsDir, name);
    const sql = await readFile(path, "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");

    const { rows } = await pool.query<{ sha256: string }>(
      "SELECT sha256 FROM _schema_migrations WHERE name = $1",
      [name],
    );

    if (rows.length > 0) {
      if (rows[0]?.sha256 !== sha256) {
        throw new Error(
          `migration ${name} has changed since it was applied; create a new migration instead`,
        );
      }
      skipped.push(name);
      continue;
    }

    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO _schema_migrations (name, sha256) VALUES ($1, $2)", [
        name,
        sha256,
      ]);
    });
    applied.push(name);
  }

  return { applied, skipped };
}
