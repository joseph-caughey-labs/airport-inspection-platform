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
  /**
   * Base URL for audit reads. Default `/api/v1/audit` — the
   * api-gateway's reverse-proxy prefix in front of audit-service.
   * Empty string would address audit-service directly (e.g. an
   * older nginx config); the default keeps the public surface
   * fronted by api-gateway.
   */
  baseUrl?: string;
  /** Returns the current access token (per-request lookup). */
  tokenProvider?: () => string | null;
  /** Refresh callback for the 401-retry path. See IncidentApi. */
  onUnauthorized?: () => Promise<string | null>;
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
  private readonly tokenProvider: () => string | null;
  private readonly onUnauthorized: (() => Promise<string | null>) | undefined;

  constructor(opts: AuditApiOptions = {}) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = opts.baseUrl ?? "/api/v1/audit";
    this.tokenProvider = opts.tokenProvider ?? (() => null);
    this.onUnauthorized = opts.onUnauthorized;
  }

  /**
   * `GET /lineage/:subject_id` (relative to `baseUrl`) — every
   * audit event for this subject, oldest first. The operator UI
   * calls this on an incident detail open + on each transition
   * that completes.
   */
  async lineage(subjectId: string): Promise<LineageResponse> {
    const url = `${this.baseUrl}/lineage/${encodeURIComponent(subjectId)}`;
    const send = (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (token) headers["authorization"] = `Bearer ${token}`;
      return this.fetchFn(url, { headers });
    };
    let res = await send(this.tokenProvider());
    if (res.status === 401 && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (fresh) res = await send(fresh);
    }
    if (!res.ok) {
      throw new AuditApiError(res.status, `audit lineage request failed: ${res.status}`);
    }
    return (await res.json()) as LineageResponse;
  }
}
