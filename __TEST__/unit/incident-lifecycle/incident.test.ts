import type { IncidentStatus } from "@aip/shared-contracts";
import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  Incident,
  type IncidentSnapshot,
  TerminalStateError,
} from "../../../services/incident-service/src/domain/index.js";

const NOW = new Date("2026-05-29T10:00:00.000Z");

function makeSnapshot(overrides: Partial<IncidentSnapshot> = {}): IncidentSnapshot {
  return {
    id: "inc-1",
    airport_id: "11111111-1111-1111-1111-aaaaaaaaaaaa",
    severity: "high",
    title: "FOD on RWY 10L",
    status: "new" as IncidentStatus,
    created_at: "2026-05-29T09:00:00.000Z",
    updated_at: "2026-05-29T09:00:00.000Z",
    history: [],
    ...overrides,
  };
}

describe("Incident.dispatch — snapshot threading", () => {
  it("returns next snapshot with updated status + updated_at", () => {
    const inc = new Incident(makeSnapshot());
    const r = inc.dispatch({ command: "acknowledge", actor: "op-1", now: () => NOW });
    expect(r.next.status).toBe("acknowledged");
    expect(r.next.updated_at).toBe(NOW.toISOString());
  });

  it("appends to history immutably (original snapshot untouched)", () => {
    const original = makeSnapshot();
    const inc = new Incident(original);
    const r = inc.dispatch({ command: "acknowledge", actor: "op-1", now: () => NOW });
    expect(r.next.history).toHaveLength(1);
    expect(r.next.history[0]?.to).toBe("acknowledged");
    expect(original.history).toEqual([]); // never mutated
  });

  it("history is the audit trail across multiple transitions", () => {
    let snap = makeSnapshot();
    let inc = new Incident(snap);
    for (const command of ["acknowledge", "assign", "start_progress", "resolve"] as const) {
      const r = inc.dispatch({ command, actor: "op-1", now: () => NOW });
      snap = r.next;
      inc = new Incident(snap);
    }
    expect(snap.history.map((t) => t.to)).toEqual([
      "acknowledged",
      "assigned",
      "in_progress",
      "resolved",
    ]);
  });
});

describe("Incident.dispatch — wire event shape", () => {
  it("emits an event with the canonical envelope shape", () => {
    const inc = new Incident(makeSnapshot());
    const r = inc.dispatch({
      command: "acknowledge",
      actor: "op-1",
      now: () => NOW,
      correlation_id: "corr-1",
    });
    expect(r.event.event_type).toBe("incident.transitioned");
    expect(r.event.schema_version).toBe("v1");
    expect(r.event.incident_id).toBe("inc-1");
    expect(r.event.correlation_id).toBe("corr-1");
    expect(r.event.transition.to).toBe("acknowledged");
  });

  it("omits correlation_id when not supplied", () => {
    const inc = new Incident(makeSnapshot());
    const r = inc.dispatch({ command: "acknowledge", actor: "op-1" });
    expect("correlation_id" in r.event).toBe(false);
  });

  it("passes the reason through to the event payload", () => {
    const inc = new Incident(makeSnapshot({ status: "in_progress" }));
    const r = inc.dispatch({
      command: "resolve",
      actor: "op-1",
      reason: "tow truck removed object",
    });
    expect(r.event.transition.reason).toBe("tow truck removed object");
  });
});

describe("Incident.dispatch — error propagation", () => {
  it("throws IllegalTransitionError when the command doesn't apply", () => {
    const inc = new Incident(makeSnapshot());
    expect(() => inc.dispatch({ command: "resolve", actor: "op-1" })).toThrow(
      IllegalTransitionError,
    );
  });

  it("throws TerminalStateError once archived", () => {
    const inc = new Incident(makeSnapshot({ status: "archived" }));
    expect(() => inc.dispatch({ command: "acknowledge", actor: "op-1" })).toThrow(
      TerminalStateError,
    );
  });

  it("error includes from + command", () => {
    const inc = new Incident(makeSnapshot());
    try {
      inc.dispatch({ command: "resolve", actor: "op-1" });
    } catch (e) {
      expect((e as IllegalTransitionError).from).toBe("new");
      expect((e as IllegalTransitionError).command).toBe("resolve");
    }
  });
});
