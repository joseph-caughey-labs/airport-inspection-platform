import { z } from "zod";
import { IncidentStatus } from "../enums/incident-status.js";
import { Severity } from "../enums/severity.js";

/**
 * Canonical incident envelope returned by every incident REST endpoint
 * (T-402) and consumed by frontend stores. Maps 1:1 to the `incidents`
 * row in `db-schema/0001_initial.sql`; the field names are snake_case
 * to match the wire format the rest of the platform uses.
 *
 * Notes:
 *   - `details` is a free-form jsonb on the database side; we keep it
 *     `Record<string, unknown>` here rather than enumerate every
 *     possible payload shape (FOD detection, snowbank violation, etc.).
 *   - `acknowledged_at` / `assigned_to` / `resolved_at` only get set
 *     as the state machine walks the lifecycle. The transition record
 *     in `IncidentHistoryEntry` is the source of truth for "who did
 *     what when" — these top-level fields are denormalized for fast
 *     list queries.
 */
export const Incident = z.object({
  id: z.string().uuid(),
  airport_id: z.string().uuid(),
  runway_id: z.string().uuid().nullable().optional(),
  severity: Severity,
  status: IncidentStatus,
  title: z.string().min(1).max(300),
  details: z.record(z.unknown()).nullable().optional(),
  acknowledged_by: z.string().uuid().nullable().optional(),
  acknowledged_at: z.string().datetime().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  resolved_at: z.string().datetime().nullable().optional(),
  idempotency_key: z.string().min(1).max(200).nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Incident = z.infer<typeof Incident>;

/** Request body for `POST /incidents` (typically called by the
 * validation engine on Layer 10 cert, T-411). The status defaults to
 * `new`; the lifecycle endpoints in T-403/T-404 move it forward. */
export const CreateIncidentRequest = z.object({
  airport_id: z.string().uuid(),
  runway_id: z.string().uuid().optional(),
  severity: Severity,
  title: z.string().min(1).max(300),
  details: z.record(z.unknown()).optional(),
  /** When set, the same idempotency_key must collapse repeated POSTs
   * into a single row (partial-unique index in 0001_initial.sql). */
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequest>;

/** Query filters for `GET /incidents`. All optional; all combine
 * with AND. Pagination is via the shared cursor scheme. */
export const ListIncidentsQuery = z.object({
  status: IncidentStatus.optional(),
  severity: Severity.optional(),
  airport_id: z.string().uuid().optional(),
  runway_id: z.string().uuid().optional(),
  /** ISO-8601 lower bound on `created_at` (inclusive). */
  created_after: z.string().datetime().optional(),
  /** ISO-8601 upper bound on `created_at` (exclusive). */
  created_before: z.string().datetime().optional(),
});
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuery>;

/**
 * Request body for `POST /incidents/:id/acknowledge` (T-403).
 *
 * - `operator_id`: the user uuid taking responsibility for triage.
 *   Required — every transition needs an actor in the audit trail.
 * - `note`: optional short context the operator types in the UI
 *   (e.g. "tower confirmed visual on FOD"). Stored on the
 *   transition record; surfaced in the audit log later.
 */
export const AcknowledgeIncidentRequest = z.object({
  operator_id: z.string().uuid(),
  note: z.string().min(1).max(500).optional(),
});
export type AcknowledgeIncidentRequest = z.infer<typeof AcknowledgeIncidentRequest>;

/**
 * Request bodies for the remaining lifecycle commands (T-404).
 *
 * Every transition needs an `operator_id` so the audit trail can name
 * an actor. Beyond that, each command has its own contract:
 *
 *   - `assign`         → needs `assignee_id` (the responder being
 *                        routed to). `note` is optional context.
 *   - `start_progress` → no extra fields; the actor is the assignee
 *                        beginning work.
 *   - `resolve`        → `resolution_summary` is REQUIRED — operators
 *                        must explain how the incident was closed for
 *                        the post-incident review.
 *   - `escalate`       → `reason` is REQUIRED. Time-in-state /
 *                        severity-driven auto-escalations populate
 *                        this with the trigger ("sla_breach",
 *                        "severity_override", etc).
 *   - `archive`        → `note` optional; usually called by an
 *                        end-of-day sweep, not an operator typing.
 *   - `reject`         → `reason` is REQUIRED — most rejections come
 *                        from the validation engine (T-405) with the
 *                        failing layer name.
 */
export const AssignIncidentRequest = z.object({
  operator_id: z.string().uuid(),
  assignee_id: z.string().uuid(),
  note: z.string().min(1).max(500).optional(),
});
export type AssignIncidentRequest = z.infer<typeof AssignIncidentRequest>;

export const StartProgressIncidentRequest = z.object({
  operator_id: z.string().uuid(),
  note: z.string().min(1).max(500).optional(),
});
export type StartProgressIncidentRequest = z.infer<typeof StartProgressIncidentRequest>;

export const ResolveIncidentRequest = z.object({
  operator_id: z.string().uuid(),
  resolution_summary: z.string().min(1).max(2000),
});
export type ResolveIncidentRequest = z.infer<typeof ResolveIncidentRequest>;

export const EscalateIncidentRequest = z.object({
  operator_id: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
export type EscalateIncidentRequest = z.infer<typeof EscalateIncidentRequest>;

export const ArchiveIncidentRequest = z.object({
  operator_id: z.string().uuid(),
  note: z.string().min(1).max(500).optional(),
});
export type ArchiveIncidentRequest = z.infer<typeof ArchiveIncidentRequest>;

export const RejectIncidentRequest = z.object({
  operator_id: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
export type RejectIncidentRequest = z.infer<typeof RejectIncidentRequest>;
