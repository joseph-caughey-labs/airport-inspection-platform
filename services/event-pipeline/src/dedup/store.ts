/**
 * TTL-bounded in-memory dedup store.
 *
 * Each key is associated with an `expiresAt` epoch ms. A key is
 * considered present iff `expiresAt > now`. Expired entries are
 * cleaned lazily on add (every Nth insertion) — explicit `sweep()`
 * is also exposed for tests and scheduled cleanup.
 *
 * Single-process only. Multi-instance dedup uses Redis SETEX in
 * the production evolution path (out of scope for T-206).
 */
export class DedupStore {
  private readonly entries = new Map<string, number>();
  private readonly windowMs: number;
  private readonly sweepInterval: number;
  private opCount = 0;

  constructor(opts: { windowMs?: number; sweepInterval?: number } = {}) {
    this.windowMs = opts.windowMs ?? 5_000;
    this.sweepInterval = opts.sweepInterval ?? 100;
  }

  has(key: string, now: number = Date.now()): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, now: number = Date.now()): void {
    this.entries.set(key, now + this.windowMs);
    this.opCount++;
    if (this.opCount % this.sweepInterval === 0) {
      this.sweep(now);
    }
  }

  /** Drop every entry whose `expiresAt <= now`. */
  sweep(now: number = Date.now()): number {
    let dropped = 0;
    for (const [k, exp] of this.entries) {
      if (exp <= now) {
        this.entries.delete(k);
        dropped++;
      }
    }
    return dropped;
  }

  /** Number of entries currently tracked (including expired-but-not-swept). */
  size(): number {
    return this.entries.size;
  }

  /** Reset everything — primarily for tests. */
  clear(): void {
    this.entries.clear();
    this.opCount = 0;
  }
}
