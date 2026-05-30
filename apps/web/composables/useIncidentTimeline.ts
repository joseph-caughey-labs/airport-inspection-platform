/**
 * Composable that fetches the audit lineage for a single incident
 * and exposes the playback-ready timeline + a reactive cursor.
 *
 * Used by `IncidentTimeline.vue` on the airport detail page. Keeps
 * the AuditApi instantiation + cursor state out of the component so
 * the component can be tested with stubbed props instead of mocking
 * fetch at the component layer.
 */
import { computed, ref, watch, type Ref } from "vue";
import { useAuthStore } from "~/stores/auth";
import { AuditApi } from "~/utils/audit-api";
import { buildIncidentTimeline, snapshotAt, type TimelineStep } from "~/utils/incident-timeline";

export interface UseIncidentTimelineOptions {
  /** Override the AuditApi (tests inject one with a mock fetch). */
  api?: AuditApi;
  /** Override the base URL when no explicit api is passed. */
  baseUrl?: string;
}

export function useIncidentTimeline(
  incidentId: Ref<string | undefined>,
  options: UseIncidentTimelineOptions = {},
) {
  // When the test passes an explicit `api`, honour it untouched — the
  // existing test suite mocks fetch through that injection point.
  // Otherwise build a default client wired up to the auth store so
  // every lineage call carries an Authorization header and lazily
  // refreshes on 401.
  let api: AuditApi;
  if (options.api) {
    api = options.api;
  } else {
    const auth = useAuthStore();
    api = new AuditApi({
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      tokenProvider: () => auth.accessToken,
      onUnauthorized: () => auth.refresh(),
    });
  }

  const steps = ref<TimelineStep[]>([]);
  const cursor = ref(0);
  const pending = ref(false);
  const error = ref<Error | undefined>(undefined);

  const currentStep = computed(() => snapshotAt(steps.value, cursor.value));
  const atFirst = computed(() => cursor.value <= 0);
  const atLast = computed(() => cursor.value >= Math.max(0, steps.value.length - 1));

  function setCursor(idx: number): void {
    if (steps.value.length === 0) {
      cursor.value = 0;
      return;
    }
    cursor.value = Math.max(0, Math.min(idx, steps.value.length - 1));
  }
  function prev(): void {
    setCursor(cursor.value - 1);
  }
  function next(): void {
    setCursor(cursor.value + 1);
  }
  function jumpToLast(): void {
    setCursor(steps.value.length - 1);
  }

  async function refresh(): Promise<void> {
    if (!incidentId.value) {
      steps.value = [];
      cursor.value = 0;
      return;
    }
    pending.value = true;
    error.value = undefined;
    try {
      const response = await api.lineage(incidentId.value);
      const built = buildIncidentTimeline(response.items);
      steps.value = built;
      // Keep the operator looking at the most recent transition on
      // refresh — a new transition lands AFTER the cursor, not at it.
      cursor.value = Math.max(0, built.length - 1);
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      steps.value = [];
    } finally {
      pending.value = false;
    }
  }

  // Refetch whenever the incident id changes — including the initial
  // mount.
  watch(incidentId, () => void refresh(), { immediate: true });

  return {
    steps,
    cursor,
    currentStep,
    pending,
    error,
    atFirst,
    atLast,
    refresh,
    setCursor,
    prev,
    next,
    jumpToLast,
  };
}
