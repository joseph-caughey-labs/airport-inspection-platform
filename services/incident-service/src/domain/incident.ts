import type { IncidentStatus, Severity } from "@aip/shared-contracts";
import {
  TerminalStateError,
  transition as runTransition,
  type IncidentCommand,
  type Transition,
} from "./state-machine.js";
import { buildTransitionEvent, type IncidentTransitionedEvent } from "./events.js";

/**
 * Aggregate root for an incident. Owns:
 *   - identity (`id`, `airport_id`, optional `sensor_id`)
 *   - lifecycle (`status` + ordered `history`)
 *   - the side-effects of a transition (a Redis-ready event)
 *
 * The class is intentionally thin — no I/O, no Redis, no Postgres.
 * The write path in T-402 will instantiate one from a DB row,
 * call `dispatch()`, then persist the new status + history + publish
 * the resulting event.
 */
export interface IncidentSnapshot {
  id: string;
  airport_id: string;
  sensor_id?: string;
  severity: Severity;
  title: string;
  detail?: string;
  status: IncidentStatus;
  assignee?: string;
  created_at: string;
  updated_at: string;
  history: readonly Transition[];
}

export interface DispatchOptions {
  command: IncidentCommand;
  actor: string;
  reason?: string;
  /** Test seam. Defaults to `new Date()`. */
  now?: () => Date;
  /** Correlation id propagated through to the published event. */
  correlation_id?: string;
}

export interface DispatchResult {
  /** Updated snapshot — caller persists. */
  next: IncidentSnapshot;
  /** Just-applied transition — same as `next.history.at(-1)`. */
  transition: Transition;
  /** Wire-format event ready for Redis publish. */
  event: IncidentTransitionedEvent;
}

export class Incident {
  private readonly snapshot: IncidentSnapshot;

  constructor(snapshot: IncidentSnapshot) {
    this.snapshot = snapshot;
  }

  get current(): IncidentSnapshot {
    return this.snapshot;
  }

  /**
   * Apply a command, returning the next snapshot + the transition +
   * the wire event. Throws `IllegalTransitionError` /
   * `TerminalStateError` on rejection — the HTTP layer in T-402
   * maps both to 4xx and never returns 5xx for domain rejections.
   */
  dispatch(opts: DispatchOptions): DispatchResult {
    const transition = runTransition(this.snapshot.status, opts.command, {
      actor: opts.actor,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    const next: IncidentSnapshot = {
      ...this.snapshot,
      status: transition.to,
      updated_at: transition.occurred_at,
      history: [...this.snapshot.history, transition],
    };
    return {
      next,
      transition,
      event: buildTransitionEvent(this.snapshot.id, transition, opts.correlation_id),
    };
  }

  /** Re-export for callers that prefer not to import the type module. */
  static TerminalStateError = TerminalStateError;
}
