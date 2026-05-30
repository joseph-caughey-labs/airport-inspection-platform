/**
 * Incident timeline builder tests (T-414).
 *
 * Pure helper exercised against fabricated audit rows. The
 * composable + Vue component reuse this helper, so its correctness
 * underpins the whole feature.
 */
import { describe, expect, it } from "vitest";
import { buildIncidentTimeline, snapshotAt } from "~/utils/incident-timeline";
import type { AuditEventRow } from "~/utils/audit-api";

function row(overrides: Partial<AuditEventRow> & { transition?: unknown } = {}): AuditEventRow {
  const { transition, ...rest } = overrides;
  return {
    seq: "1",
    event_id: "ev-1",
    occurred_at: "2026-05-29T10:00:00.000Z",
    source: "incident-service",
    event_type: "incident.transitioned",
    actor_user_id: "actor-1",
    subject_id: "incident-1",
    payload: transition ? { transition } : {},
    prev_hash: null,
    entry_hash: "h",
    correlation_id: null,
    rationale: null,
    ...rest,
  };
}

function transition(from: string, to: string, command: string, occurred_at: string) {
  return { from, to, command, actor: "actor-1", reason: null, occurred_at };
}

describe("buildIncidentTimeline", () => {
  it("returns an empty list when there are no transitions", () => {
    expect(buildIncidentTimeline([])).toEqual([]);
  });

  it("prepends an implicit `created` step at the from-state of the first transition", () => {
    const steps = buildIncidentTimeline([
      row({
        event_id: "ev-1",
        transition: transition("new", "acknowledged", "acknowledge", "2026-05-29T10:00:00.000Z"),
      }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ kind: "created", status: "new" });
    expect(steps[1]).toMatchObject({
      kind: "transition",
      from: "new",
      status: "acknowledged",
      command: "acknowledge",
    });
  });

  it("sorts by occurred_at ascending even when the input is out of order", () => {
    const steps = buildIncidentTimeline([
      row({
        event_id: "ev-2",
        transition: transition("acknowledged", "assigned", "assign", "2026-05-29T10:05:00.000Z"),
      }),
      row({
        event_id: "ev-1",
        transition: transition("new", "acknowledged", "acknowledge", "2026-05-29T10:00:00.000Z"),
      }),
    ]);
    expect(steps.map((s) => s.status)).toEqual(["new", "acknowledged", "assigned"]);
  });

  it("filters out non-incident.transitioned event_types", () => {
    const steps = buildIncidentTimeline([
      row({
        event_id: "ev-1",
        transition: transition("new", "acknowledged", "acknowledge", "2026-05-29T10:00:00.000Z"),
      }),
      row({ event_id: "ev-other", event_type: "audit.heartbeat", transition: undefined }),
    ]);
    expect(steps).toHaveLength(2);
  });

  it("drops rows with a malformed transition", () => {
    const steps = buildIncidentTimeline([
      row({ event_id: "ev-bad", payload: { transition: { from: "x", to: "y" } } }),
      row({
        event_id: "ev-good",
        transition: transition("new", "acknowledged", "acknowledge", "2026-05-29T10:00:00.000Z"),
      }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[1]?.kind).toBe("transition");
  });

  it("threads actor + rationale onto each transition step", () => {
    const steps = buildIncidentTimeline([
      row({
        event_id: "ev-1",
        actor_user_id: "operator-1",
        rationale: "tower confirmed",
        transition: transition("new", "acknowledged", "acknowledge", "2026-05-29T10:00:00.000Z"),
      }),
    ]);
    const ack = steps[1]!;
    expect(ack.actor).toBe("operator-1");
    expect(ack.rationale).toBe("tower confirmed");
  });
});

describe("snapshotAt", () => {
  const steps = [
    {
      kind: "created" as const,
      id: "a",
      status: "new" as const,
      occurred_at: "",
      actor: null,
      rationale: null,
    },
    {
      kind: "transition" as const,
      id: "b",
      status: "acknowledged" as const,
      occurred_at: "",
      actor: null,
      rationale: null,
    },
    {
      kind: "transition" as const,
      id: "c",
      status: "assigned" as const,
      occurred_at: "",
      actor: null,
      rationale: null,
    },
  ];

  it("clamps a negative index to 0", () => {
    expect(snapshotAt(steps, -3)?.id).toBe("a");
  });

  it("clamps a past-end index to the last step", () => {
    expect(snapshotAt(steps, 99)?.id).toBe("c");
  });

  it("returns undefined on an empty timeline", () => {
    expect(snapshotAt([], 0)).toBeUndefined();
  });
});
