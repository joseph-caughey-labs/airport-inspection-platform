import type { Incident, ListIncidentsQuery } from "@aip/shared-contracts";

/**
 * Repository interface for incident persistence.
 *
 * Split as an interface so the routes can be tested against an
 * in-memory fake (`InMemoryIncidentRepository`) without spinning up
 * Postgres, AND so a future Drizzle/pg implementation can swap in
 * without touching the route layer.
 *
 * Cursor encoding: the Postgres implementation encodes
 * `(created_at, id)` so a stable secondary key breaks ties on the
 * same-millisecond rows. The in-memory implementation does the same
 * shape so tests assert against the same cursor format.
 */
export interface IncidentListResult {
  items: Incident[];
  next_cursor: string | null;
  total?: number;
}

export interface IncidentRepository {
  create(input: NewIncidentInput): Promise<Incident>;
  findById(id: string): Promise<Incident | null>;
  list(filter: ListIncidentsQuery, page: PageRequest): Promise<IncidentListResult>;
  /**
   * Replace the whole record. The lifecycle endpoints in T-403/T-404
   * use this to persist post-transition snapshots. The state machine
   * has already validated legality; the repo just writes.
   */
  save(incident: Incident): Promise<Incident>;
}

export interface NewIncidentInput {
  id?: string;
  airport_id: string;
  runway_id?: string | undefined;
  severity: Incident["severity"];
  status?: Incident["status"];
  title: string;
  details?: Record<string, unknown> | undefined;
  idempotency_key?: string | undefined;
  /** Override clock for deterministic tests. */
  now?: () => Date;
}

export interface PageRequest {
  cursor?: string | undefined;
  limit: number;
}

export class IncidentNotFoundError extends Error {
  readonly code = "INCIDENT_NOT_FOUND";

  constructor(readonly id: string) {
    super(`incident ${id} not found`);
    this.name = "IncidentNotFoundError";
  }
}

export class IdempotencyKeyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";

  constructor(
    readonly key: string,
    readonly existingId: string,
  ) {
    super(`idempotency_key ${key} already used by incident ${existingId}`);
    this.name = "IdempotencyKeyConflictError";
  }
}
