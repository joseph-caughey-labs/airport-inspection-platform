import type { PoolClient } from "pg";
import type { PgPool } from "./client.js";

export type TransactionFn<T> = (client: PoolClient) => Promise<T>;

/**
 * Run `fn` inside a single `BEGIN ... COMMIT` transaction. The
 * client is checked out from the pool, passed to `fn`, and returned
 * to the pool when `fn` settles.
 *
 * - `fn` returns ⇒ `COMMIT`, return its value.
 * - `fn` throws ⇒ `ROLLBACK`, re-throw the original error.
 * - Pool client is always released, even on rollback failure.
 */
export async function withTransaction<T>(pool: PgPool, fn: TransactionFn<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Swallow rollback failure — surface the original error instead.
    }
    throw err;
  } finally {
    client.release();
  }
}
