import { defineStore } from "pinia";

export type ConnectionState = "connecting" | "connected" | "stale" | "disconnected";

export interface SystemState {
  /** Aggregate connection state of the upstream API + WS pipeline. */
  connection: ConnectionState;
  /** Current airport context. Multi-airport switcher in T-211. */
  airportIcao: string | null;
  /** App version for the about/diagnostic strip. */
  version: string;
}

export const useSystemStore = defineStore("system", {
  state: (): SystemState => ({
    connection: "connecting",
    airportIcao: null,
    version: "0.4.0",
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
