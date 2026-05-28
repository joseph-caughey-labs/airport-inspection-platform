import type { Sensor, SensorStatus } from "~/types/airport";

export interface SensorHealthSummary {
  total: number;
  byStatus: Record<SensorStatus, number>;
  /** Sensors whose last-seen is older than `staleThresholdSec`. */
  staleCount: number;
  /** Worst observed status — drives the panel's headline color. */
  worst: SensorStatus;
}

const STATUS_RANK: Record<SensorStatus, number> = {
  online: 0,
  degraded: 1,
  offline: 2,
};

const DEFAULT_STALE_SEC = 120;

/**
 * Pure summary of a sensor list. Used by SensorHealthPanel for the
 * headline numbers + stale-sensor alert; reused in alert-count
 * calculations and (later in T-213) for the WS connection card.
 *
 * Determined entirely from inputs — `now` is parameterized so tests
 * pin the clock without mocking globals.
 */
export function summarizeSensorHealth(
  sensors: readonly Sensor[],
  now: Date = new Date(),
  staleThresholdSec: number = DEFAULT_STALE_SEC,
): SensorHealthSummary {
  const byStatus: Record<SensorStatus, number> = { online: 0, degraded: 0, offline: 0 };
  let staleCount = 0;
  let worst: SensorStatus = "online";
  for (const s of sensors) {
    byStatus[s.status]++;
    if (STATUS_RANK[s.status] > STATUS_RANK[worst]) worst = s.status;
    const seenMs = Date.parse(s.last_seen_at);
    if (Number.isFinite(seenMs)) {
      const ageSec = (now.getTime() - seenMs) / 1000;
      if (ageSec > staleThresholdSec) staleCount++;
    }
  }
  return { total: sensors.length, byStatus, staleCount, worst };
}
