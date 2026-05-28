import Redis, { type RedisOptions as IoRedisOptions } from "ioredis";

export type RedisClient = Redis;

export interface RedisOptions extends IoRedisOptions {
  /** Max reconnect attempts before giving up. Default 20. */
  maxRetries?: number;
  /** Cap on the per-attempt backoff in ms. Default 5_000. */
  maxBackoffMs?: number;
}

/**
 * Create an ioredis client with safe defaults:
 *
 * - Exponential backoff reconnect (100ms → 5s cap).
 * - Maximum 20 reconnect attempts (configurable).
 * - `lazyConnect: false` so connection issues surface immediately.
 *
 * Note: pub/sub requires a **separate** client for subscribing.
 * Create a second instance with the same options for the subscriber.
 */
export function createRedis(opts: RedisOptions): RedisClient {
  const { maxRetries = 20, maxBackoffMs = 5_000, retryStrategy, ...rest } = opts;

  const effectiveRetryStrategy =
    retryStrategy ??
    ((times: number): number | null => {
      if (times > maxRetries) return null; // stop retrying
      return Math.min(100 * 2 ** Math.min(times, 6), maxBackoffMs);
    });

  return new Redis({
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    ...rest,
    retryStrategy: effectiveRetryStrategy,
  });
}
