import { type ChannelRegistry } from "../channels/registry.js";
import { type PresenceEntry } from "../channels/types.js";

export const PRESENCE_EVENT_TYPE = "presence.changed";
export const PRESENCE_SNAPSHOT_TYPE = "presence.snapshot";

/**
 * Wraps a presence list into the same WS envelope shape live frames
 * use, so the client has exactly one parser. `presence.snapshot` is
 * sent once on connect (only to the new subscriber); `presence.changed`
 * fans out to everyone whenever the set changes.
 */
export function buildPresenceMessage(
  type: typeof PRESENCE_EVENT_TYPE | typeof PRESENCE_SNAPSHOT_TYPE,
  airportId: string,
  entries: PresenceEntry[],
  now: () => string = () => new Date().toISOString(),
): string {
  return JSON.stringify({
    type,
    schema_version: "v1",
    timestamp: now(),
    payload: {
      airport_id: airportId,
      count: entries.length,
      subscribers: entries,
    },
  });
}

/**
 * Notifies all current subscribers of an airport that the presence
 * set changed. Uses the registry's own dispatch path so the same
 * filter / metrics path applies to presence as to sensor frames.
 *
 * Idempotent in spirit — if nobody is subscribed, this is a no-op.
 * The caller passes the registry to keep this side-effect-light: a
 * single call site (the route's subscribe/unsubscribe hooks).
 */
export function broadcastPresenceChange(
  registry: ChannelRegistry,
  airportId: string,
  now: () => string = () => new Date().toISOString(),
): void {
  const entries = registry.snapshot(airportId);
  const payload = buildPresenceMessage(PRESENCE_EVENT_TYPE, airportId, entries, now);
  registry.dispatch(airportId, PRESENCE_EVENT_TYPE, payload);
}
