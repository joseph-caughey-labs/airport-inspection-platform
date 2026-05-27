import type { RedisClient } from "./client.js";

export interface HealthResult {
  healthy: boolean;
  latency_ms: number;
  error?: string;
}

/**
 * Readiness probe. Sends `PING` and measures round-trip latency.
 * Sanitizes errors — no stack traces leak into the response.
 */
export async function checkHealth(redis: RedisClient): Promise<HealthResult> {
  const start = process.hrtime.bigint();
  try {
    const reply = await redis.ping();
    const latency_ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    return {
      healthy: reply === "PONG",
      latency_ms,
      ...(reply !== "PONG" ? { error: `unexpected reply: ${reply}` } : {}),
    };
  } catch (err) {
    const latency_ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    return {
      healthy: false,
      latency_ms,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}
