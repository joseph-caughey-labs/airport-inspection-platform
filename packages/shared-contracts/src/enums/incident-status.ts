import { z } from "zod";

/**
 * Incident lifecycle states. Transitions are enforced by the
 * incident-service state machine (T-401).
 */
export const IncidentStatus = z.enum([
  "new",
  "acknowledged",
  "assigned",
  "in_progress",
  "resolved",
  "escalated",
  "archived",
  "rejected",
]);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

/** Terminal states — no further transitions allowed. */
export const TERMINAL_INCIDENT_STATUSES: ReadonlySet<IncidentStatus> = new Set([
  "resolved",
  "archived",
  "rejected",
]);
