/**
 * Canonical channel domains. New domains require an ADR (or at least
 * a design note) because they imply new ownership and event taxonomy.
 */
export type ChannelDomain =
  | "sensor"
  | "ai"
  | "validation"
  | "incident"
  | "audit"
  | "notification"
  | "system";

const CHANNEL_SEGMENT = /^[a-z0-9_]+$/;

export function isValidChannelName(name: string): boolean {
  const parts = name.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => CHANNEL_SEGMENT.test(p));
}

/**
 * Build a `<domain>.<entity>.<action>` channel name and validate the
 * shape. Throws on invalid inputs so misuse fails at startup, not
 * silently at runtime.
 *
 * Examples:
 *   buildChannelName("sensor", "frame", "captured")
 *     → "sensor.frame.captured"
 *   buildChannelName("ai", "detection", "emitted")
 *     → "ai.detection.emitted"
 */
export function buildChannelName(domain: ChannelDomain, entity: string, action: string): string {
  for (const [label, value] of [
    ["entity", entity],
    ["action", action],
  ] as const) {
    if (!CHANNEL_SEGMENT.test(value)) {
      throw new Error(`Invalid channel ${label} "${value}" — must match /^[a-z0-9_]+$/`);
    }
  }
  return `${domain}.${entity}.${action}`;
}
