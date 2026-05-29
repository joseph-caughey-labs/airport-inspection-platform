import type { IncidentStatus } from "@aip/shared-contracts";

/**
 * Operator/system commands that drive the incident lifecycle. Each
 * command names an *intent* (`acknowledge`, `assign`, `resolve`)
 * rather than a target state — the state machine maps it to the
 * correct next state given the current one.
 *
 * Reviewed by the Domain Expert (`__PLANNING__/ROLES/13_domain-expert.md`)
 * for naming + consequences. See `docs/architecture/incident-lifecycle.md`.
 */
export type IncidentCommand =
  | "acknowledge"
  | "assign"
  | "start_progress"
  | "resolve"
  | "escalate"
  | "archive"
  | "reject";

/**
 * Legal transitions, keyed by the *current* status. The value is the
 * map from command → next status. Any (status, command) pair NOT in
 * this table is illegal and throws `IllegalTransitionError`.
 *
 * Side branches:
 *   - `escalate`  available from every active state. Once escalated,
 *                 the only way out is `acknowledge` → `assigned`
 *                 (re-routing) or `reject` (false alarm) or
 *                 `resolve` (handled in-flight).
 *   - `archive`   terminal-only from `resolved`. Used to move
 *                 closed incidents out of the operator queue without
 *                 deleting them.
 *   - `reject`    validation-driven; available from any non-terminal
 *                 state. Used by T-405 validation engine to discard
 *                 false-positive incidents.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<IncidentStatus, Partial<Record<IncidentCommand, IncidentStatus>>>
> = {
  new: {
    acknowledge: "acknowledged",
    escalate: "escalated",
    reject: "rejected",
  },
  acknowledged: {
    assign: "assigned",
    escalate: "escalated",
    reject: "rejected",
  },
  assigned: {
    start_progress: "in_progress",
    escalate: "escalated",
    reject: "rejected",
  },
  in_progress: {
    resolve: "resolved",
    escalate: "escalated",
    reject: "rejected",
  },
  escalated: {
    acknowledge: "assigned",
    resolve: "resolved",
    reject: "rejected",
  },
  resolved: {
    archive: "archived",
  },
  archived: {},
  rejected: {},
};

/**
 * States with no outbound transitions. Derived from the table so it
 * stays in sync if a future PR adds a command out of `archived` or
 * `rejected` (none planned, but the invariant should be a property
 * of the table, not a hand-maintained list).
 *
 * Note this is the state-machine's local notion of "terminal" and
 * differs from `TERMINAL_INCIDENT_STATUSES` in `@aip/shared-contracts`,
 * which uses "operationally terminal" — i.e. `resolved` is in that set
 * because the operator's work is done, even though the state machine
 * still has an `archive` transition out of it.
 */
const STATES_WITHOUT_TRANSITIONS: ReadonlySet<IncidentStatus> = new Set(
  (Object.entries(LEGAL_TRANSITIONS) as [IncidentStatus, Record<string, IncidentStatus>][])
    .filter(([, edges]) => Object.keys(edges).length === 0)
    .map(([state]) => state),
);

export class IllegalTransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION";

  constructor(
    readonly from: IncidentStatus,
    readonly command: IncidentCommand,
  ) {
    super(`illegal transition from ${from} via ${command}`);
    this.name = "IllegalTransitionError";
  }
}

export class TerminalStateError extends Error {
  readonly code = "TERMINAL_STATE";

  constructor(
    readonly state: IncidentStatus,
    readonly command: IncidentCommand,
  ) {
    super(`incident already in terminal state ${state}; cannot ${command}`);
    this.name = "TerminalStateError";
  }
}

export interface TransitionContext {
  /** Who initiated the transition — operator id, "system", "validator". */
  actor: string;
  /** Optional reason (escalation note, rejection cause, resolution summary). */
  reason?: string;
  /** Override clock for deterministic tests. */
  now?: () => Date;
}

export interface Transition {
  from: IncidentStatus;
  to: IncidentStatus;
  command: IncidentCommand;
  actor: string;
  reason?: string;
  occurred_at: string;
}

/**
 * Pure state machine. Single responsibility: given a current state
 * and a command, return the next state + a serializable transition
 * record. Callers (the incident-service write path) decide what to do
 * with the resulting transition — persist it, publish on Redis,
 * raise a notification.
 *
 * Throws `TerminalStateError` if the incident is already in a
 * terminal state; throws `IllegalTransitionError` otherwise when
 * the command doesn't have a legal target from `from`. Both are
 * typed so the HTTP layer can map them to a 4xx without leaking the
 * error class.
 */
export function transition(
  from: IncidentStatus,
  command: IncidentCommand,
  ctx: TransitionContext,
): Transition {
  if (STATES_WITHOUT_TRANSITIONS.has(from)) {
    throw new TerminalStateError(from, command);
  }
  const next = LEGAL_TRANSITIONS[from][command];
  if (next === undefined) {
    throw new IllegalTransitionError(from, command);
  }
  const now = ctx.now ? ctx.now() : new Date();
  return {
    from,
    to: next,
    command,
    actor: ctx.actor,
    ...(ctx.reason !== undefined ? { reason: ctx.reason } : {}),
    occurred_at: now.toISOString(),
  };
}

/**
 * Predicates exposed for callers that need to render UI state
 * (e.g. graying out the "Acknowledge" button) without invoking
 * the full state machine and catching exceptions.
 */
export function isLegalCommand(from: IncidentStatus, command: IncidentCommand): boolean {
  if (STATES_WITHOUT_TRANSITIONS.has(from)) return false;
  return LEGAL_TRANSITIONS[from][command] !== undefined;
}

export function availableCommands(from: IncidentStatus): IncidentCommand[] {
  if (STATES_WITHOUT_TRANSITIONS.has(from)) return [];
  return Object.keys(LEGAL_TRANSITIONS[from]) as IncidentCommand[];
}

export function isTerminal(state: IncidentStatus): boolean {
  return STATES_WITHOUT_TRANSITIONS.has(state);
}
