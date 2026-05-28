/**
 * Minimal interface the channel registry needs from a connected client.
 * Modeled after `ws.WebSocket` but kept narrow so tests can pass a
 * plain object without needing the full WebSocket implementation.
 *
 * The `role` is opaque to the registry today — it's stored for the
 * per-role topic filter that will activate once RBAC lands in T-504.
 * Until then, every authenticated client gets every event on its
 * airport channel.
 */
export interface BroadcastClient {
  send(data: string): void;
  /** Best-effort terminate; the route calls this on auth/parse failure. */
  close(code?: number, reason?: string): void;
  readonly role: ClientRole;
  /** Server-issued id used in presence + audit. */
  readonly connection_id: string;
  /** ISO-8601 timestamp of the successful upgrade. */
  readonly connected_at: string;
}

export type ClientRole = "operator" | "supervisor" | "viewer" | "system";

/** Per-subscriber view exposed by `ChannelRegistry.snapshot()` for presence broadcasts. */
export interface PresenceEntry {
  connection_id: string;
  role: ClientRole;
  connected_at: string;
}

/** Topic predicates the registry consults before dispatching a frame. */
export interface ClientFilter {
  /**
   * Return `true` to deliver the payload to this client. Today this
   * returns `true` unconditionally; T-504 will plug in role + topic
   * predicates without touching the route.
   */
  allow(role: ClientRole, eventType: string): boolean;
}

export const ALLOW_ALL: ClientFilter = {
  allow: () => true,
};
