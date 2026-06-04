/**
 * Fetches a single incident envelope from incident-service for the
 * detail page header (status badge, severity, title, assignee).
 *
 * Sibling to `useIncidentTimeline` — both are watched off the same
 * `incidentId` ref, but they hit different services: this one
 * pulls the current envelope from incident-service, the timeline
 * pulls the audit lineage from audit-service. The split mirrors
 * the production backend separation.
 *
 * The fetched envelope also lands in `useIncidentsStore` so the
 * store cache is warm for any other view that wants it (e.g. a
 * later list/queue page).
 *
 * Auth: per-request bearer + lazy 401 refresh via the shared auth
 * store, same posture as `IncidentApi`'s POST methods. Tests pass
 * an explicit `api` to skip the store wiring.
 */
import { ref, watch, type Ref } from "vue";
import type { Incident } from "@aip/shared-contracts";
import { useAuthStore } from "~/stores/auth";
import { useIncidentsStore } from "~/stores/incidents";
import { IncidentApi, type IncidentApiError } from "~/utils/incident-api";

export interface UseIncidentDetailOptions {
  /** Override the IncidentApi (tests pass one with a mock fetch). */
  api?: IncidentApi;
  /** Override the base URL when no explicit api is passed. */
  baseUrl?: string;
}

export function useIncidentDetail(
  incidentId: Ref<string | undefined>,
  options: UseIncidentDetailOptions = {},
) {
  // Build a default api with the auth store wired through, unless
  // the caller passed an explicit one — same trick the timeline
  // composable uses.
  let api: IncidentApi;
  if (options.api) {
    api = options.api;
  } else {
    const auth = useAuthStore();
    api = new IncidentApi({
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      tokenProvider: () => auth.accessToken,
      onUnauthorized: () => auth.refresh(),
    });
  }

  const incidents = useIncidentsStore();

  const incident = ref<Incident | undefined>(undefined);
  const pending = ref(false);
  const error = ref<IncidentApiError | Error | undefined>(undefined);

  async function refresh(): Promise<void> {
    if (!incidentId.value) {
      incident.value = undefined;
      return;
    }
    pending.value = true;
    error.value = undefined;
    try {
      const fetched = await api.get(incidentId.value);
      incident.value = fetched;
      incidents.set(fetched);
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      incident.value = undefined;
    } finally {
      pending.value = false;
    }
  }

  watch(incidentId, () => void refresh(), { immediate: true });

  return {
    incident,
    pending,
    error,
    refresh,
  };
}
