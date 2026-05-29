import { defineStore } from "pinia";
import type { Incident } from "@aip/shared-contracts";
import type { IncidentApi } from "~/utils/incident-api";
import { IncidentApiError } from "~/utils/incident-api";

export interface IncidentsState {
  /** Loaded incidents keyed by id. The list/timeline views derive from this. */
  byId: Record<string, Incident>;
  /** Per-incident "in flight" flags so the UI can disable buttons mid-request. */
  pending: Record<string, boolean>;
  /** Last error per incident (cleared on a successful subsequent call). */
  errors: Record<string, IncidentApiError | undefined>;
}

/**
 * Incident store. Optimistic updates first, then API call, then
 * reconciliation. The acknowledged-at timestamp on the optimistic
 * update is a sentinel ("pending"); the server's response is the
 * source of truth and overwrites it.
 */
export const useIncidentsStore = defineStore("incidents", {
  state: (): IncidentsState => ({
    byId: {},
    pending: {},
    errors: {},
  }),
  getters: {
    /** A loaded incident, or undefined if we haven't fetched it. */
    get:
      (state) =>
      (id: string): Incident | undefined =>
        state.byId[id],
    isPending:
      (state) =>
      (id: string): boolean =>
        state.pending[id] === true,
    errorFor:
      (state) =>
      (id: string): IncidentApiError | undefined =>
        state.errors[id],
  },
  actions: {
    /** Inject from a list/detail fetch (T-414 wires real fetching). */
    set(incident: Incident): void {
      this.byId = { ...this.byId, [incident.id]: incident };
    },

    /**
     * Acknowledge an incident: optimistically flip status →
     * `acknowledged` (without `acknowledged_at` since we don't know
     * the server timestamp yet), POST, then reconcile with the
     * server-returned envelope.
     *
     * On API failure: revert the optimistic change and store the
     * error so the row can render it.
     */
    async acknowledge(
      id: string,
      payload: { operator_id: string; note?: string },
      deps: { api: IncidentApi },
    ): Promise<Incident | undefined> {
      const original = this.byId[id];
      if (!original) {
        // Caller didn't load the incident first — refuse silently
        // rather than guess.
        return undefined;
      }
      this.byId = {
        ...this.byId,
        [id]: { ...original, status: "acknowledged", acknowledged_by: payload.operator_id },
      };
      this.pending = { ...this.pending, [id]: true };
      this.errors = { ...this.errors, [id]: undefined };
      try {
        const updated = await deps.api.acknowledge(id, payload);
        // Server response wins; merge it back in (overwriting the
        // optimistic status + filling in `acknowledged_at`).
        this.byId = { ...this.byId, [id]: updated };
        this.pending = { ...this.pending, [id]: false };
        return updated;
      } catch (err) {
        const apiErr = err instanceof IncidentApiError ? err : undefined;
        this.byId = { ...this.byId, [id]: original }; // revert
        this.pending = { ...this.pending, [id]: false };
        this.errors = { ...this.errors, [id]: apiErr };
        throw err;
      }
    },
  },
});
