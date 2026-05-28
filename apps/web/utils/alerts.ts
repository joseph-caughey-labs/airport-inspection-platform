import type { AlertItem, AlertSeverity } from "~/types/alert";
import { SEVERITY_RANK } from "~/types/alert";

/**
 * Maps an event_type string to its default severity. The mapping
 * is intentionally pessimistic — anything we don't explicitly
 * downgrade is treated as `info` so unknown events never quietly
 * inflate the critical-count badge.
 *
 * T-3xx will extend this for AI detection event types.
 */
export function severityFromEventType(eventType: string): AlertSeverity {
  if (eventType === "incident.created") return "critical";
  if (eventType === "incident.escalated") return "high";
  if (eventType.startsWith("ai.detection.")) return "medium";
  if (eventType.startsWith("sensor.")) return "info";
  if (eventType.startsWith("presence.")) return "info";
  if (eventType.startsWith("system.")) return "low";
  return "info";
}

/**
 * Short human label per event_type. Long-form detail goes into the
 * `detail` field; this is for the chip / row title that has to be
 * scannable at a glance.
 */
export function titleForEventType(eventType: string): string {
  switch (eventType) {
    case "sensor.frame.captured":
      return "Sensor telemetry";
    case "presence.snapshot":
      return "Subscribers snapshot";
    case "presence.changed":
      return "Subscribers changed";
    case "incident.created":
      return "Incident opened";
    case "incident.escalated":
      return "Incident escalated";
    default:
      return eventType;
  }
}

/**
 * Compact relative-time formatter. `5s` / `12m` / `3h` / `2d`.
 * Deterministic — takes both `now` and `then` so tests don't need
 * to mock Date.now().
 */
export function formatRelativeTime(then: string | Date, now: Date = new Date()): string {
  const thenMs = typeof then === "string" ? Date.parse(then) : then.getTime();
  if (Number.isNaN(thenMs)) return "—";
  const deltaSec = Math.max(0, Math.floor((now.getTime() - thenMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 48) return `${deltaHr}h`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d`;
}

/**
 * Picks the worst severity from a set of alerts. Returns `info`
 * when the list is empty so callers don't need to null-check.
 */
export function worstSeverity(items: readonly AlertItem[]): AlertSeverity {
  let worst: AlertSeverity = "info";
  for (const item of items) {
    if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[worst]) worst = item.severity;
  }
  return worst;
}

/**
 * Counts items by severity. Always includes every severity key so
 * the badge strip can render a stable shape regardless of the
 * current alert mix.
 */
export function countsBySeverity(items: readonly AlertItem[]): Record<AlertSeverity, number> {
  const counts: Record<AlertSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const item of items) counts[item.severity]++;
  return counts;
}

/**
 * Inserts `next` into `current` keeping the list sorted by
 * `received_at` DESC, capped at `maxItems`. Deduplicates on `id`
 * so a re-delivery from at-least-once Redis fan-out doesn't double-
 * count. Returns a new array — caller substitutes the reference.
 *
 * Pure: no Vue, no Pinia. Reused by the store and by tests.
 */
export function insertAlert(current: AlertItem[], next: AlertItem, maxItems: number): AlertItem[] {
  if (current.some((c) => c.id === next.id)) return current;
  // Newest first — the feed displays in this order.
  const merged = [next, ...current];
  merged.sort((a, b) =>
    a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0,
  );
  if (merged.length > maxItems) merged.length = maxItems;
  return merged;
}
