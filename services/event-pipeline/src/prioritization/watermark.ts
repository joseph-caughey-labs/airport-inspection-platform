/**
 * Out-of-order classification per sensor.
 *
 * The tracker keeps the latest `captured_at` it has seen for each
 * sensor_id. Every incoming frame falls into one of three buckets:
 *
 *  - `in_order`           — captured_at >= latest (advance the watermark)
 *  - `late_in_window`     — captured_at < latest, but within the tolerance
 *                           (acceptable jitter; pass through, count it)
 *  - `late_beyond_window` — captured_at < latest by more than tolerance
 *                           (route to replay queue; T-215 drains)
 *
 * In-memory, single-process for the demo. Production evolution:
 * Redis-backed watermark per sensor for multi-instance ordering.
 */
export type OrderStatus = "in_order" | "late_in_window" | "late_beyond_window";

export class WatermarkTracker {
  private readonly latest = new Map<string, number>();
  private readonly toleranceMs: number;

  constructor(opts: { toleranceMs?: number } = {}) {
    this.toleranceMs = opts.toleranceMs ?? 30_000;
  }

  /** Classify and (if in_order) advance the watermark for this sensor. */
  check(sensorId: string, capturedAtMs: number): OrderStatus {
    const last = this.latest.get(sensorId);
    if (last === undefined || capturedAtMs >= last) {
      this.latest.set(sensorId, capturedAtMs);
      return "in_order";
    }
    if (last - capturedAtMs <= this.toleranceMs) {
      return "late_in_window";
    }
    return "late_beyond_window";
  }

  /** Current watermark for a sensor, or null when not yet seen. */
  watermarkFor(sensorId: string): number | null {
    return this.latest.get(sensorId) ?? null;
  }

  /** Reset all watermarks (for tests). */
  clear(): void {
    this.latest.clear();
  }
}
