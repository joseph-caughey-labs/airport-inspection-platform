import { defineStore } from "pinia";

export interface PresenceSubscriber {
  connection_id: string;
  role: string;
  connected_at: string;
}

export interface PresenceState {
  /** keyed by airport_id */
  byAirport: Record<string, PresenceSubscriber[]>;
}

/**
 * Holds the current per-airport subscriber roster, replaced wholesale
 * on each `presence.snapshot` / `presence.changed` from the server.
 * The server is authoritative — we never patch this client-side from
 * heuristics; the WS broadcaster owns the ground truth.
 *
 * Pure Pinia — no zod / no decode. The `useWebSocket` orchestrator
 * upstream is responsible for parsing and calling `set()`.
 */
export const usePresenceStore = defineStore("presence", {
  state: (): PresenceState => ({ byAirport: {} }),
  getters: {
    countFor:
      (s) =>
      (airportId: string): number =>
        s.byAirport[airportId]?.length ?? 0,
    listFor:
      (s) =>
      (airportId: string): PresenceSubscriber[] =>
        s.byAirport[airportId] ?? [],
  },
  actions: {
    set(airportId: string, subscribers: PresenceSubscriber[]): void {
      // Assign a new object so reactivity fires on the airportId key.
      this.byAirport = { ...this.byAirport, [airportId]: subscribers };
    },
    clear(airportId: string): void {
      if (!(airportId in this.byAirport)) return;
      const next = { ...this.byAirport };
      delete next[airportId];
      this.byAirport = next;
    },
  },
});
