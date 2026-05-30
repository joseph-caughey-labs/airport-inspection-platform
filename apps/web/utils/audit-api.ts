/**
 * Read-only client for the audit-service. Operators use this for
 * incident timelines + post-incident reviews; we never write through
 * here (writes flow through the original publishers, which
 * audit-service subscribes to).
 *
 * Lives in `utils/` alongside `incident-api.ts` so it's
 * unit-testable without spinning up Pinia.
 */

/**
 * One canonical audit row as returned by audit-service. Mirrors the
 * `audit_events` table; the field names match the wire format the
 * service emits. We keep `payload` as `Record<string, unknown>`
 * because every `source` carries a different shape (incident
 * envelope, validation run, etc.).
 */
export interface AuditEventRow {
  seq: string;
  event_id: string;
  occurred_at: string;
  source: string;
  event_type: string;
  actor_user_id: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string | null;
  entry_hash: string;
  correlation_id: string | null;
  rationale: string | null;
}

export interface LineageResponse {
  subject_id: string;
  items: AuditEventRow[];
  total: number;
}

export interface AuditApiOptions {
  /** Override fetch (tests inject a mock). */
  fetchFn?: typeof fetch;
  /** Base URL for the audit-service. Empty string uses same-origin. */
  baseUrl?: string;
}

export class AuditApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuditApiError";
    this.status = status;
  }
}

export class AuditApi {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: AuditApiOptions = {}) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = opts.baseUrl ?? "";
  }

  /**
   * `GET /audit/lineage/:subject_id` — every audit event for this
   * subject, oldest first. The operator UI calls this on an
   * incident detail open + on each transition that completes.
   */
  async lineage(subjectId: string): Promise<LineageResponse> {
    const res = await this.fetchFn(
      `${this.baseUrl}/audit/lineage/${encodeURIComponent(subjectId)}`,
    );
    if (!res.ok) {
      throw new AuditApiError(res.status, `audit lineage request failed: ${res.status}`);
    }
    return (await res.json()) as LineageResponse;
  }
}
