/**
 * useIncidentDetail composable tests.
 *
 * Drives the composable with a fake IncidentApi so cursor +
 * refresh semantics don't have to mock fetch. Pinia is initialized
 * because the composable touches `useIncidentsStore` to seed the
 * cache on fetch success.
 */
import { setActivePinia, createPinia } from "pinia";
import { ref, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIncidentDetail } from "~/composables/useIncidentDetail";
import { useIncidentsStore } from "~/stores/incidents";
import type { IncidentApi } from "~/utils/incident-api";
import { IncidentApiError } from "~/utils/incident-api";

const INCIDENT_A = "11111111-1111-1111-1111-111111111111";
const INCIDENT_B = "22222222-2222-2222-2222-222222222222";
const AIRPORT = "33333333-3333-3333-3333-333333333333";

function makeEnvelope(id: string, status = "acknowledged") {
  return {
    id,
    airport_id: AIRPORT,
    severity: "high" as const,
    status: status as "new" | "acknowledged",
    title: `incident ${id.slice(0, 8)}`,
    created_at: "2026-05-29T09:00:00.000Z",
    updated_at: "2026-05-29T10:00:00.000Z",
  };
}

function fakeApi(responses: Record<string, ReturnType<typeof makeEnvelope>>): IncidentApi {
  return {
    get: vi.fn(async (id: string) => {
      const r = responses[id];
      if (!r)
        throw new IncidentApiError(404, { error: { code: "INCIDENT_NOT_FOUND", message: "x" } });
      return r;
    }),
  } as unknown as IncidentApi;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("useIncidentDetail", () => {
  it("fetches on mount and exposes the envelope", async () => {
    const api = fakeApi({ [INCIDENT_A]: makeEnvelope(INCIDENT_A) });
    const id = ref<string | undefined>(INCIDENT_A);
    const { incident, pending } = useIncidentDetail(id, { api });
    // The watcher fires synchronously with `immediate: true`, then
    // the async fetch resolves on the next microtask.
    await nextTick();
    await nextTick();
    expect(incident.value?.id).toBe(INCIDENT_A);
    expect(pending.value).toBe(false);
  });

  it("seeds the incidents store on a successful fetch", async () => {
    const api = fakeApi({ [INCIDENT_A]: makeEnvelope(INCIDENT_A) });
    const id = ref<string | undefined>(INCIDENT_A);
    const { incident } = useIncidentDetail(id, { api });
    await nextTick();
    await nextTick();
    expect(incident.value?.id).toBe(INCIDENT_A);
    const store = useIncidentsStore();
    expect(store.get(INCIDENT_A)?.id).toBe(INCIDENT_A);
  });

  it("refetches when the incidentId ref changes", async () => {
    const api = fakeApi({
      [INCIDENT_A]: makeEnvelope(INCIDENT_A, "acknowledged"),
      [INCIDENT_B]: makeEnvelope(INCIDENT_B, "resolved"),
    });
    const id = ref<string | undefined>(INCIDENT_A);
    const { incident } = useIncidentDetail(id, { api });
    await nextTick();
    await nextTick();
    expect(incident.value?.status).toBe("acknowledged");

    id.value = INCIDENT_B;
    await nextTick();
    await nextTick();
    expect(incident.value?.status).toBe("resolved");
    expect((api.get as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      INCIDENT_A,
      INCIDENT_B,
    ]);
  });

  it("exposes the error and clears the incident when fetch throws 404", async () => {
    const api = fakeApi({}); // no fixtures → every id 404s
    const id = ref<string | undefined>(INCIDENT_A);
    const { incident, error } = useIncidentDetail(id, { api });
    await nextTick();
    await nextTick();
    expect(incident.value).toBeUndefined();
    expect(error.value).toBeInstanceOf(IncidentApiError);
    expect((error.value as IncidentApiError).status).toBe(404);
  });

  it("clears the incident when the id becomes undefined", async () => {
    const api = fakeApi({ [INCIDENT_A]: makeEnvelope(INCIDENT_A) });
    const id = ref<string | undefined>(INCIDENT_A);
    const { incident } = useIncidentDetail(id, { api });
    await nextTick();
    await nextTick();
    expect(incident.value?.id).toBe(INCIDENT_A);

    id.value = undefined;
    await nextTick();
    await nextTick();
    expect(incident.value).toBeUndefined();
  });
});
