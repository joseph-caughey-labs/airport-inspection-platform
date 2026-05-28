/**
 * In-memory replay queue. Frames classified `late_beyond_window` land
 * here instead of being processed immediately. T-215 (replay worker)
 * drains this queue once the watermark has caught up.
 *
 * The queue is bounded; over-capacity enqueues drop the OLDEST entry
 * (FIFO drop) and return false so the caller can record the loss.
 *
 * Single-process for the demo; production swaps for Redis Streams.
 */
export interface ReplayItem {
  /** Stable key used for dedup on drain (typically sensor_id+frame_id). */
  key: string;
  /** Raw envelope JSON, ready to be re-dispatched. */
  payload: string;
  enqueuedAt: number;
}

export class ReplayQueue {
  private readonly items: ReplayItem[] = [];
  private readonly maxSize: number;

  constructor(opts: { maxSize?: number } = {}) {
    this.maxSize = opts.maxSize ?? 1024;
  }

  /**
   * Enqueue an item. Returns true on accept, false on drop (queue
   * full — oldest item evicted to keep size bounded). The caller
   * is responsible for recording the drop as a metric.
   */
  enqueue(key: string, payload: string, now: number = Date.now()): boolean {
    if (this.items.length >= this.maxSize) {
      this.items.shift(); // evict oldest
      this.items.push({ key, payload, enqueuedAt: now });
      return false;
    }
    this.items.push({ key, payload, enqueuedAt: now });
    return true;
  }

  /**
   * Drain up to `limit` items in enqueue order. Callers re-dispatch
   * these via the orchestrator. Items returned are removed from the
   * queue.
   */
  drain(limit: number = Number.POSITIVE_INFINITY): ReplayItem[] {
    return this.items.splice(0, limit);
  }

  size(): number {
    return this.items.length;
  }

  /** Snapshot for tests / metrics. Does not remove items. */
  peek(): readonly ReplayItem[] {
    return this.items;
  }
}
