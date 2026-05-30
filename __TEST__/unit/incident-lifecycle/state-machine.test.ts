import type { IncidentStatus } from "@aip/shared-contracts";
import { describe, expect, it } from "vitest";
import {
  availableCommands,
  IllegalTransitionError,
  type IncidentCommand,
  isLegalCommand,
  isTerminal,
  LEGAL_TRANSITIONS,
  TerminalStateError,
  transition,
} from "../../../services/incident-service/src/domain/index.js";

const NOW = new Date("2026-05-29T10:00:00.000Z");
const ctx = { actor: "op-1", now: () => NOW };

describe("state machine — happy path", () => {
  it("walks the canonical lifecycle new → acknowledged → assigned → in_progress → resolved → archived", () => {
    let state: IncidentStatus = "new";
    const moves: { command: IncidentCommand; expected: IncidentStatus }[] = [
      { command: "acknowledge", expected: "acknowledged" },
      { command: "assign", expected: "assigned" },
      { command: "start_progress", expected: "in_progress" },
      { command: "resolve", expected: "resolved" },
      { command: "archive", expected: "archived" },
    ];
    for (const m of moves) {
      const t = transition(state, m.command, ctx);
      expect(t.to).toBe(m.expected);
      expect(t.from).toBe(state);
      expect(t.actor).toBe("op-1");
      expect(t.occurred_at).toBe(NOW.toISOString());
      state = t.to;
    }
  });

  it("populates `reason` only when supplied (exactOptionalPropertyTypes safe)", () => {
    const withReason = transition("new", "acknowledge", {
      actor: "op-1",
      reason: "operator confirmed",
    });
    expect(withReason.reason).toBe("operator confirmed");

    const withoutReason = transition("new", "acknowledge", { actor: "op-1" });
    expect("reason" in withoutReason).toBe(false);
  });
});

describe("state machine — escalation side branch", () => {
  it("allows escalate from every active state", () => {
    for (const state of ["new", "acknowledged", "assigned", "in_progress"] as const) {
      const t = transition(state, "escalate", ctx);
      expect(t.to).toBe("escalated");
    }
  });

  it("does NOT allow escalate from terminal states", () => {
    for (const state of ["archived", "rejected"] as const) {
      expect(() => transition(state, "escalate", ctx)).toThrow(TerminalStateError);
    }
  });

  it("does NOT allow escalate from `escalated` (no self-transition)", () => {
    expect(() => transition("escalated", "escalate", ctx)).toThrow(IllegalTransitionError);
  });

  it("from escalated, acknowledge routes back to assigned (re-route)", () => {
    const t = transition("escalated", "acknowledge", ctx);
    expect(t.to).toBe("assigned");
  });

  it("from escalated, resolve goes straight to resolved", () => {
    const t = transition("escalated", "resolve", ctx);
    expect(t.to).toBe("resolved");
  });

  it("from escalated, reject is allowed", () => {
    const t = transition("escalated", "reject", { ...ctx, reason: "false alarm" });
    expect(t.to).toBe("rejected");
    expect(t.reason).toBe("false alarm");
  });
});

describe("state machine — rejection / archiving", () => {
  it("allows reject from every active state", () => {
    for (const state of ["new", "acknowledged", "assigned", "in_progress", "escalated"] as const) {
      const t = transition(state, "reject", ctx);
      expect(t.to).toBe("rejected");
    }
  });

  it("does NOT allow reject from resolved (no false-alarm after resolution)", () => {
    expect(() => transition("resolved", "reject", ctx)).toThrow(IllegalTransitionError);
  });

  it("archive is only legal from resolved", () => {
    const t = transition("resolved", "archive", ctx);
    expect(t.to).toBe("archived");
    for (const state of ["new", "acknowledged", "assigned", "in_progress", "escalated"] as const) {
      expect(() => transition(state, "archive", ctx)).toThrow(IllegalTransitionError);
    }
  });
});

describe("state machine — illegal commands throw typed errors", () => {
  it("throws IllegalTransitionError for skipped steps", () => {
    expect(() => transition("new", "resolve", ctx)).toThrow(IllegalTransitionError);
    expect(() => transition("new", "assign", ctx)).toThrow(IllegalTransitionError);
    expect(() => transition("acknowledged", "resolve", ctx)).toThrow(IllegalTransitionError);
  });

  it("throws TerminalStateError from archived (not Illegal — even unknown verbs)", () => {
    const err = (() => {
      try {
        transition("archived", "acknowledge", ctx);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(TerminalStateError);
    expect((err as TerminalStateError).state).toBe("archived");
  });

  it("typed error codes are stable", () => {
    try {
      transition("new", "resolve", ctx);
    } catch (e) {
      expect((e as IllegalTransitionError).code).toBe("ILLEGAL_TRANSITION");
      expect((e as IllegalTransitionError).from).toBe("new");
      expect((e as IllegalTransitionError).command).toBe("resolve");
    }
    try {
      transition("archived", "acknowledge", ctx);
    } catch (e) {
      expect((e as TerminalStateError).code).toBe("TERMINAL_STATE");
      expect((e as TerminalStateError).state).toBe("archived");
    }
  });
});

describe("state machine — predicates", () => {
  it("isLegalCommand returns false for terminal states", () => {
    expect(isLegalCommand("archived", "acknowledge")).toBe(false);
    expect(isLegalCommand("rejected", "escalate")).toBe(false);
  });

  it("isLegalCommand matches the LEGAL_TRANSITIONS table", () => {
    for (const fromState of Object.keys(LEGAL_TRANSITIONS) as IncidentStatus[]) {
      for (const cmd of [
        "acknowledge",
        "assign",
        "start_progress",
        "resolve",
        "escalate",
        "archive",
        "reject",
      ] as IncidentCommand[]) {
        const legalPerTable =
          !isTerminal(fromState) && LEGAL_TRANSITIONS[fromState][cmd] !== undefined;
        expect(isLegalCommand(fromState, cmd)).toBe(legalPerTable);
      }
    }
  });

  it("availableCommands returns [] for terminal states", () => {
    expect(availableCommands("archived")).toEqual([]);
    expect(availableCommands("rejected")).toEqual([]);
  });

  it("availableCommands returns acknowledge + escalate + reject from `new`", () => {
    expect(new Set(availableCommands("new"))).toEqual(
      new Set(["acknowledge", "escalate", "reject"]),
    );
  });

  it("isTerminal aligns with the shared-contracts set", () => {
    expect(isTerminal("archived")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("resolved")).toBe(false);
    expect(isTerminal("new")).toBe(false);
  });
});
