import { defineStore } from "pinia";

export type ConnectionState = "connecting" | "connected" | "stale" | "disconnected";

export interface SystemState {
  /** Aggregate connection state of the upstream API + WS pipeline. */
  connection: ConnectionState;
  /** Operator role for the current session. Phase 1 stub — replaced by T-504 auth. */
  role: "operator" | "reviewer" | "admin" | null;
  /** Current airport context. Multi-airport switcher in T-211. */
  airportIcao: string | null;
  /** App version for the about/diagnostic strip. */
  version: string;
}

export const useSystemStore = defineStore("system", {
  state: (): SystemState => ({
    connection: "connecting",
    role: "operator", // Phase 1 stub — every dev session is "operator" until T-504.
    airportIcao: null,
    version: "0.3.0",
  }),
  getters: {
    isConnected: (s): boolean => s.connection === "connected",
    isOperational: (s): boolean => s.connection === "connected" || s.connection === "stale",
  },
  actions: {
    setConnection(state: ConnectionState): void {
      this.connection = state;
    },
    setAirport(icao: string | null): void {
      this.airportIcao = icao;
    },
  },
});
