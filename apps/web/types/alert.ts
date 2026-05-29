import { z } from "zod";

/**
 * In-memory alert shape consumed by the alert feed.
 *
 * Alerts originate from three places:
 *   1. `sensor.frame.captured`     → info-level telemetry tick
 *   2. AI / Parity detections      → severity per detection (T-3xx)
 *   3. Incidents + system events   → critical/high/info
 *
 * T-212 owns the schema + the rendering pipeline. T-213 will wire
 * the WS broadcaster into `alertFromEvent()` to populate the store.
 */
export const AlertSeverity = z.enum(["critical", "high", "medium", "low", "info"]);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const AlertItem = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  severity: AlertSeverity,
  title: z.string().min(1).max(160),
  detail: z.string().optional(),
  sensor_id: z.string().optional(),
  airport_id: z.string().uuid(),
  received_at: z.string().datetime(),
  /**
   * Set on AI detections whose calibrated confidence fell below the
   * "low confidence" threshold — typically the T-306 weather-degraded
   * scenario. The AlertRow renders a "LOW CONF" badge so operators
   * see the event but treat it as needs-review rather than actionable.
   */
  low_confidence: z.boolean().optional(),
});
export type AlertItem = z.infer<typeof AlertItem>;

/**
 * Severity ordering — descending priority. Used to sort badges,
 * pick the worst severity in a window, etc.
 */
export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Tailwind token name per severity — keeps the CSS class string trivial in templates. */
export const SEVERITY_TOKEN: Record<AlertSeverity, string> = {
  critical: "severity-critical",
  high: "severity-high",
  medium: "severity-medium",
  low: "severity-low",
  info: "severity-info",
};

/**
 * Shape badge per severity. UX requirement: severity is encoded by
 * shape + position + color (not color alone) so colorblind operators
 * still discriminate the worst events. Glyphs picked for distinct
 * silhouettes at 12px.
 */
export const SEVERITY_GLYPH: Record<AlertSeverity, string> = {
  critical: "▲", // upward triangle — highest visual weight
  high: "◆", // diamond
  medium: "■", // square
  low: "●", // circle
  info: "—", // dash — lowest
};
