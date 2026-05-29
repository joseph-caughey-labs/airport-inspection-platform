import { defineStore } from "pinia";
import type {
  AcknowledgeIncidentRequest,
  ArchiveIncidentRequest,
  AssignIncidentRequest,
  EscalateIncidentRequest,
  Incident,
  RejectIncidentRequest,
  ResolveIncidentRequest,
  StartProgressIncidentRequest,
} from "@aip/shared-contracts";
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
 * reconciliation. Denormalized timestamps in the optimistic patch
 * (`acknowledged_at`, `resolved_at`) are deliberately omitted — the
 * server's response is the source of truth and overwrites the
 * envelope on success.
 *
 * Every transition action shares one helper (`runTransition`) so the
 * optimistic / rollback semantics stay identical across commands —
 * one place to fix if we ever change the contract.
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

    async acknowledge(
      id: string,
      payload: AcknowledgeIncidentRequest,
      deps: { api: IncidentApi },
    ): Promise<Incident | undefined> {
      return runTransition(this, id, {
        optimistic: { status: "acknowledged", acknowledged_by: payload.operator_id },
        call: () => deps.api.acknowledge(id, payload),
      });
    },

    async assign(
      id: string,
      payload: AssignIncidentRequest,
      deps: { api: IncidentApi },
    ): Promise<Incident | undefined> {
      return runTransition(this, id, {
        optimistic: { status: "assigned", assigned_to: payload.assignee_id },
        call: () => deps.api.assign(id, payload),
      });
    },

    async startProgress(
      id: string,
      payload: StartProgressIncidentRequest,
      deps: { api: IncidentApi },
    ): Promise<Incident | undefined> {
      return runTransition(this, id, {
        optimistic: { status: "in_progress" },
        call: () => deps.api.startProgress(id, payload),
      });
    },

    async resolve(
      id: string,
      payload: ResolveIncidentRequest,
      deps: { api: IncidentApi },
    ): Promise<Incident | undefined> {
      return runTransition(this, id, {
        // Don't synthesize resolved_at — let the server timestamp win.
        optimistic: { status: "resolved" },
        call: () => deps.api.resolve(id, payload),
      });
    },

    async escalate(
      id: string,
      payload: EscalateIncidentRequest,
      deps: { api: IncidentApi },
    ): Promise<Incident | undefined> {
      return runTransition(this, id, {
        optimistic: { status: "escalated" },
        call: () => deps.api.escalate(id, payload),
      });
    },

    async archive(
      id: string,
      payload: ArchiveIncidentRequest,
      deps: { api: IncidentApi },
    ): Promise<Incident | undefined> {
      return runTransition(this, id, {
        optimistic: { status: "archived" },
        call: () => deps.api.archive(id, payload),
      });
    },

    async reject(
      id: string,
      payload: RejectIncidentRequest,
      deps: { api: IncidentApi },
    ): Promise<Incident | undefined> {
      return runTransition(this, id, {
        optimistic: { status: "rejected" },
        call: () => deps.api.reject(id, payload),
      });
    },
  },
});

/** Shape of `this` inside store actions. Spelled out as a type so
 * the shared `runTransition` helper can manipulate state outside the
 * `defineStore` `actions: {}` block without losing typing. */
type IncidentsStore = IncidentsState & {
  byId: Record<string, Incident>;
  pending: Record<string, boolean>;
  errors: Record<string, IncidentApiError | undefined>;
};

interface TransitionParams {
  /** Fields to merge onto the locally-cached incident before the
   * request fires. The server's response overwrites these on success. */
  optimistic: Partial<Incident>;
  call: () => Promise<Incident>;
}

async function runTransition(
  store: IncidentsStore,
  id: string,
  params: TransitionParams,
): Promise<Incident | undefined> {
  const original = store.byId[id];
  if (!original) {
    // Caller didn't load the incident first — refuse silently rather
    // than guess. The UI shouldn't expose transition buttons for
    // un-loaded incidents anyway.
    return undefined;
  }
  store.byId = { ...store.byId, [id]: { ...original, ...params.optimistic } };
  store.pending = { ...store.pending, [id]: true };
  store.errors = { ...store.errors, [id]: undefined };
  try {
    const updated = await params.call();
    store.byId = { ...store.byId, [id]: updated };
    store.pending = { ...store.pending, [id]: false };
    return updated;
  } catch (err) {
    const apiErr = err instanceof IncidentApiError ? err : undefined;
    store.byId = { ...store.byId, [id]: original }; // revert
    store.pending = { ...store.pending, [id]: false };
    store.errors = { ...store.errors, [id]: apiErr };
    throw err;
  }
}
