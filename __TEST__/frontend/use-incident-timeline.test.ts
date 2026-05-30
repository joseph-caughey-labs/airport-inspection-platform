/**
 * useIncidentTimeline composable tests (T-414).
 *
 * Drives the composable with a fake AuditApi so we can verify
 * cursor behavior + refresh semantics without touching fetch.
 */
import { ref, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useIncidentTimeline } from "~/composables/useIncidentTimeline";
import type { AuditApi, AuditEventRow, LineageResponse } from "~/utils/audit-api";

const INCIDENT_A = "11111111-1111-1111-1111-111111111111";
const INCIDENT_B = "22222222-2222-2222-2222-222222222222";

function row(eventId: string, from: string, to: string, occurred_at: string): AuditEventRow {
  return {
    seq: eventId,
    event_id: eventId,
    occurred_at,
    source: "incident-service",
    event_type: "incident.transitioned",
    actor_user_id: null,
    subject_id: INCIDENT_A,
    payload: { transition: { from, to, command: "x", actor: null, occurred_at } },
    prev_hash: null,
    entry_hash: "h",
    correlation_id: null,
    rationale: null,
  };
}

function fakeApi(responses: Record<string, LineageResponse>): AuditApi {
  return {
    lineage: vi.fn(async (id: string) => {
      const r = responses[id];
      if (!r) throw new Error(`no fixture for ${id}`);
      return r;
    }),
  } as unknown as AuditApi;
}

describe("useIncidentTimeline", () => {
  it("loads steps and points the cursor at the latest transition", async () => {
    const api = fakeApi({
      [INCIDENT_A]: {
        subject_id: INCIDENT_A,
        total: 2,
        items: [
          row("ev-1", "new", "acknowledged", "2026-05-29T10:00:00.000Z"),
          row("ev-2", "acknowledged", "assigned", "2026-05-29T10:05:00.000Z"),
        ],
      },
    });
    const id = ref<string | undefined>(INCIDENT_A);
    const tl = useIncidentTimeline(id, { api });
    await nextTick();
    await Promise.resolve(); // let watch handler resolve
    await Promise.resolve();
    expect(tl.steps.value).toHaveLength(3); // created + 2 transitions
    expect(tl.cursor.value).toBe(2);
    expect(tl.currentStep.value?.status).toBe("assigned");
  });

  it("refetches when the incidentId ref changes", async () => {
    const api = fakeApi({
      [INCIDENT_A]: { subject_id: INCIDENT_A, total: 0, items: [] },
      [INCIDENT_B]: {
        subject_id: INCIDENT_B,
        total: 1,
        items: [row("ev-3", "new", "acknowledged", "2026-05-29T11:00:00.000Z")],
      },
    });
    const id = ref<string | undefined>(INCIDENT_A);
    const tl = useIncidentTimeline(id, { api });
    await Promise.resolve();
    await Promise.resolve();
    expect(tl.steps.value).toHaveLength(0);

    id.value = INCIDENT_B;
    await Promise.resolve();
    await Promise.resolve();
    expect(tl.steps.value).toHaveLength(2);
  });

  it("clamps prev/next at the boundaries", async () => {
    const api = fakeApi({
      [INCIDENT_A]: {
        subject_id: INCIDENT_A,
        total: 1,
        items: [row("ev-1", "new", "acknowledged", "2026-05-29T10:00:00.000Z")],
      },
    });
    const id = ref<string | undefined>(INCIDENT_A);
    const tl = useIncidentTimeline(id, { api });
    await Promise.resolve();
    await Promise.resolve();
    // Two steps: created + one transition. cursor lands on 1 (last).
    expect(tl.cursor.value).toBe(1);
    tl.next();
    expect(tl.cursor.value).toBe(1); // clamped
    tl.prev();
    expect(tl.cursor.value).toBe(0);
    tl.prev();
    expect(tl.cursor.value).toBe(0); // clamped at 0
  });

  it("exposes the error when the API throws", async () => {
    const throwingApi = {
      lineage: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as AuditApi;
    const id = ref<string | undefined>(INCIDENT_A);
    const tl = useIncidentTimeline(id, { api: throwingApi });
    await Promise.resolve();
    await Promise.resolve();
    expect(tl.error.value?.message).toBe("boom");
    expect(tl.steps.value).toEqual([]);
  });

  it("setCursor clamps to the valid range", async () => {
    const api = fakeApi({
      [INCIDENT_A]: {
        subject_id: INCIDENT_A,
        total: 1,
        items: [row("ev-1", "new", "acknowledged", "2026-05-29T10:00:00.000Z")],
      },
    });
    const id = ref<string | undefined>(INCIDENT_A);
    const tl = useIncidentTimeline(id, { api });
    await Promise.resolve();
    await Promise.resolve();
    tl.setCursor(99);
    expect(tl.cursor.value).toBe(1);
    tl.setCursor(-5);
    expect(tl.cursor.value).toBe(0);
  });
});
