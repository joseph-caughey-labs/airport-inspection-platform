import type { PgPool } from "./client.js";

export interface HealthResult {
  healthy: boolean;
  latency_ms: number;
  error?: string;
}

/**
 * Readiness probe. Issues a cheap `SELECT 1` and measures round-trip
 * latency. Suitable for `/ready` endpoints.
 *
 * - `healthy: true`  → query returned within timeout.
 * - `healthy: false` → query threw or the pool is unavailable.
 *   `error` carries the message (sanitized — no stack trace).
 */
export async function checkHealth(pool: PgPool): Promise<HealthResult> {
  const start = process.hrtime.bigint();
  try {
    await pool.query("SELECT 1");
    const latency_ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    return { healthy: true, latency_ms };
  } catch (err) {
    const latency_ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    return {
      healthy: false,
      latency_ms,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}
