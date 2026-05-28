import { defineStore } from "pinia";
import { countsBySeverity, insertAlert, worstSeverity } from "~/utils/alerts";
import type { AlertItem, AlertSeverity } from "~/types/alert";

const DEFAULT_MAX = 1000; // T-212 acceptance: 1000-item feed without jank.

/**
 * In-memory alert feed. Survives the lifetime of the dashboard
 * tab; refilled from the WS hydration burst on each (re)connect
 * (T-213).
 *
 * The pure `insertAlert` / `countsBySeverity` helpers live in
 * `utils/alerts.ts` so they're unit-testable without Pinia. This
 * store is a thin shell over them plus the connection state for
 * the feed's loading / error states.
 */
export type FeedState = "idle" | "loading" | "ready" | "error";

export interface AlertsState {
  items: AlertItem[];
  maxItems: number;
  feedState: FeedState;
  /** Last error message — surfaced in the AlertFeed error block. */
  error: string | null;
  /** Connection ix — bumped on every WS reconnect so the feed can show a "reconnected" hint. */
  reconnectCount: number;
}

export const useAlertsStore = defineStore("alerts", {
  state: (): AlertsState => ({
    items: [],
    maxItems: DEFAULT_MAX,
    feedState: "idle",
    error: null,
    reconnectCount: 0,
  }),
  getters: {
    counts: (s): Record<AlertSeverity, number> => countsBySeverity(s.items),
    worst: (s): AlertSeverity => worstSeverity(s.items),
    isEmpty: (s): boolean => s.items.length === 0,
    /** Filtered subset (returned eagerly because the list is bounded). */
    forAirport:
      (s) =>
      (airportId: string): AlertItem[] =>
        s.items.filter((i) => i.airport_id === airportId),
  },
  actions: {
    push(item: AlertItem): void {
      this.items = insertAlert(this.items, item, this.maxItems);
    },
    pushMany(items: AlertItem[]): void {
      for (const item of items) this.items = insertAlert(this.items, item, this.maxItems);
    },
    clear(): void {
      this.items = [];
    },
    setFeedState(state: FeedState, error: string | null = null): void {
      this.feedState = state;
      this.error = state === "error" ? error : null;
    },
    noteReconnect(): void {
      this.reconnectCount++;
    },
  },
});
