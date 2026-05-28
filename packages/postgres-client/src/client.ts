import pg from "pg";
import type { PoolConfig } from "pg";

const { Pool } = pg;

export type PgPool = pg.Pool;

export interface PgPoolOptions extends PoolConfig {
  /** Pool size; default 10. */
  max?: number;
  /** Idle connection timeout in ms; default 30_000. */
  idleTimeoutMillis?: number;
  /** Connect timeout in ms; default 5_000. */
  connectionTimeoutMillis?: number;
  /** Server-side `statement_timeout` (ms); default 30_000. */
  statementTimeoutMillis?: number;
}

/**
 * Create a `pg.Pool` with safe defaults. Pass any standard `pg`
 * options to override.
 *
 * Notes:
 * - Sets `statement_timeout` via session SQL on every new connection
 *   to prevent runaway queries from hanging the service.
 * - Does NOT call `pool.connect()` eagerly — the first query
 *   establishes the connection.
 */
export function createPgPool(opts: PgPoolOptions): PgPool {
  const {
    max = 10,
    idleTimeoutMillis = 30_000,
    connectionTimeoutMillis = 5_000,
    statementTimeoutMillis = 30_000,
    ...rest
  } = opts;

  const pool = new Pool({
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    ...rest,
  });

  // Apply statement_timeout per-connection.
  pool.on("connect", (client) => {
    void client.query(`SET statement_timeout = ${statementTimeoutMillis}`);
  });

  return pool;
}
