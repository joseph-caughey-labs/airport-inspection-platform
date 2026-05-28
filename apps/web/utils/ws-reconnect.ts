/**
 * Exponential backoff with jitter for WebSocket reconnect. Pure so
 * the test suite can pin both `attempt` and a deterministic
 * `randomFn`.
 *
 * Curve: 250ms × 2^attempt, capped at `maxMs`. Jitter is ±25% of
 * the deterministic delay so a fleet of clients doesn't thunder
 * on the same socket simultaneously.
 *
 * `attempt` starts at 0 for the first retry; callers increment on
 * each failed reconnect.
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Test seam — defaults to Math.random. */
  randomFn?: () => number;
}

const DEFAULT_BASE = 250;
const DEFAULT_MAX = 15_000;

export function nextReconnectDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? DEFAULT_BASE;
  const max = opts.maxMs ?? DEFAULT_MAX;
  const rand = opts.randomFn ?? Math.random;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
  // ±25% jitter — `rand()` in [0, 1) → factor in [0.75, 1.25)
  const jitterFactor = 0.75 + rand() * 0.5;
  return Math.round(Math.min(max, exp * jitterFactor));
}
