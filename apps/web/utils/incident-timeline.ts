/**
 * Pure helper that turns an audit lineage response into a
 * playback-ready timeline for the operator dashboard.
 *
 * The audit log stores the raw `incident.transitioned` envelope
 * per row; here we extract the operator-relevant fields and add an
 * implicit `created` step at the start (when an incident is first
 * seen in the audit log, the row before its first transition is
 * the "created" event in the timeline).
 *
 * Pure with respect to its inputs so the timeline tests don't need
 * any DOM or Pinia.
 */
import type { IncidentStatus } from "@aip/shared-contracts";
import type { AuditEventRow } from "./audit-api.js";

export type TimelineStepKind = "created" | "transition";

export interface TimelineStep {
  kind: TimelineStepKind;
  /** Stable id for v-for. Combines kind + row event_id. */
  id: string;
  /** Status the incident is IN after this step completes. */
  status: IncidentStatus;
  /** ISO-8601. */
  occurred_at: string;
  /** Operator UUID when known; null when system-emitted. */
  actor: string | null;
  /** Free-form reason ("tower confirmed visual", "sla_breach", etc). */
  rationale: string | null;
  /** Previous status — `undefined` on the `created` step. */
  from?: IncidentStatus;
  /** Command name ("acknowledge", "assign", etc) — `undefined` on the
   * `created` step. */
  command?: string;
}

interface TransitionPayload {
  transition?: {
    from?: unknown;
    to?: unknown;
    command?: unknown;
    actor?: unknown;
    reason?: unknown;
    occurred_at?: unknown;
  };
}

/**
 * Convert audit rows for one incident into ordered timeline steps.
 *
 * Filters out non-`incident.transitioned` audit rows (the audit log
 * may carry other event_types from later integrations); validates
 * the transition shape inline rather than via zod since this is a
 * cheap render-path helper.
 */
export function buildIncidentTimeline(rows: readonly AuditEventRow[]): TimelineStep[] {
  const transitions = rows
    .filter((r) => r.event_type === "incident.transitioned")
    .map(extractTransition)
    .filter((t): t is ExtractedTransition => t !== undefined)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  if (transitions.length === 0) return [];

  const first = transitions[0]!;
  const created: TimelineStep = {
    kind: "created",
    id: `created:${first.event_id}`,
    status: first.from,
    occurred_at: first.occurred_at,
    actor: null,
    rationale: null,
  };

  const steps: TimelineStep[] = [created];
  for (const t of transitions) {
    steps.push({
      kind: "transition",
      id: `transition:${t.event_id}`,
      status: t.to,
      occurred_at: t.occurred_at,
      actor: t.actor,
      rationale: t.rationale,
      from: t.from,
      command: t.command,
    });
  }
  return steps;
}

/**
 * Returns the step at `index` clamped to the timeline range. Used by
 * the playback control to render a snapshot for the slider position.
 */
export function snapshotAt(
  steps: readonly TimelineStep[],
  index: number,
): TimelineStep | undefined {
  if (steps.length === 0) return undefined;
  const clamped = Math.max(0, Math.min(index, steps.length - 1));
  return steps[clamped];
}

interface ExtractedTransition {
  event_id: string;
  occurred_at: string;
  from: IncidentStatus;
  to: IncidentStatus;
  command: string;
  actor: string | null;
  rationale: string | null;
}

const VALID_STATUSES: ReadonlySet<IncidentStatus> = new Set([
  "new",
  "acknowledged",
  "assigned",
  "in_progress",
  "resolved",
  "escalated",
  "archived",
  "rejected",
]);

function extractTransition(row: AuditEventRow): ExtractedTransition | undefined {
  const payload = row.payload as TransitionPayload;
  const t = payload.transition;
  if (!t || typeof t !== "object") return undefined;
  const from = isStatus(t.from) ? t.from : undefined;
  const to = isStatus(t.to) ? t.to : undefined;
  if (!from || !to) return undefined;
  const command = typeof t.command === "string" ? t.command : undefined;
  if (!command) return undefined;
  return {
    event_id: row.event_id,
    occurred_at: typeof t.occurred_at === "string" ? t.occurred_at : row.occurred_at,
    from,
    to,
    command,
    actor: row.actor_user_id,
    rationale: row.rationale,
  };
}

function isStatus(v: unknown): v is IncidentStatus {
  return typeof v === "string" && VALID_STATUSES.has(v as IncidentStatus);
}
