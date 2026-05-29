import { type Transition } from "./state-machine.js";

/**
 * Domain event published to Redis on every successful incident
 * transition. Two downstream consumers:
 *
 *   - audit-service (T-412) persists every event to the append-only
 *     `audit_events` table for the hash-chained audit trail.
 *   - notification-service (T-413) routes events to operator
 *     channels (in-app toast, webhook, email-stub).
 *
 * Channel naming follows `@aip/redis-client`:
 *     incident.transition.<next_state>
 *
 * The next_state segment lets notification rules subscribe to just
 * the events they care about (e.g. only `escalated` and `resolved`).
 */
export const INCIDENT_TRANSITION_DOMAIN = "incident";
export const INCIDENT_TRANSITION_ENTITY = "transition";

export function channelFor(transition: Transition): string {
  return `${INCIDENT_TRANSITION_DOMAIN}.${INCIDENT_TRANSITION_ENTITY}.${transition.to}`;
}

export interface IncidentTransitionedEvent {
  event_type: "incident.transitioned";
  schema_version: "v1";
  incident_id: string;
  transition: Transition;
  /** Optional correlation id passed in by the caller (e.g. operator request). */
  correlation_id?: string;
}

/**
 * Builds the canonical event envelope from the state-machine output.
 * Pure — the actual Redis `PUBLISH` lives in the incident-service
 * write path (T-402). Keeping construction here lets unit tests
 * assert envelope shape without spinning up Redis.
 */
export function buildTransitionEvent(
  incidentId: string,
  transition: Transition,
  correlationId?: string,
): IncidentTransitionedEvent {
  return {
    event_type: "incident.transitioned",
    schema_version: "v1",
    incident_id: incidentId,
    transition,
    ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
  };
}
