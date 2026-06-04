/**
 * Thin REST client for the incident-service. Lives here (utils/, not
 * stores/) so the pure HTTP shape is unit-testable without spinning
 * up Pinia.
 *
 * Every call returns the canonical envelope from
 * `@aip/shared-contracts` — same shape the OpenAPI spec describes,
 * same shape the operator UI consumes.
 */

import type {
  AcknowledgeIncidentRequest,
  ArchiveIncidentRequest,
  AssignIncidentRequest,
  EscalateIncidentRequest,
  Incident,
  RejectIncidentRequest,
  ResolveIncidentRequest,
  StartProgressIncidentRequest,
} from "@aip/shared-contracts";

export interface IncidentApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class IncidentApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown> | undefined;

  constructor(status: number, body: IncidentApiErrorBody) {
    super(body.error.message);
    this.name = "IncidentApiError";
    this.status = status;
    this.code = body.error.code;
    this.details = body.error.details;
  }
}

export interface IncidentApiOptions {
  /** Override fetch (tests inject a mock). */
  fetchFn?: typeof fetch;
  /**
   * Base URL for incident writes. Default `/api/v1/incidents` —
   * the api-gateway's reverse-proxy prefix in front of
   * incident-service. Empty string would address incident-service
   * directly (e.g. via an older nginx route); the default routes
   * through api-gateway so the auth + rate-limit posture stays
   * uniform with the rest of the public surface.
   */
  baseUrl?: string;
  /**
   * Returns the current access token (or null when unauthenticated).
   * Called per request so a refresh between calls is observed
   * without the API client re-subscribing to the auth store.
   */
  tokenProvider?: () => string | null;
  /**
   * Called on a 401. Implementations should attempt to refresh and
   * return a fresh access token, or null to give up (which leaves
   * the 401 to surface to the caller). The API client retries the
   * request exactly once.
   */
  onUnauthorized?: () => Promise<string | null>;
}

export class IncidentApi {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly tokenProvider: () => string | null;
  private readonly onUnauthorized: (() => Promise<string | null>) | undefined;

  constructor(opts: IncidentApiOptions = {}) {
    // Bind fetch to globalThis so the standard fetch isn't called as a
    // method of `IncidentApi` (which would lose its receiver).
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = opts.baseUrl ?? "/api/v1/incidents";
    this.tokenProvider = opts.tokenProvider ?? (() => null);
    this.onUnauthorized = opts.onUnauthorized;
  }

  /**
   * `GET /:id` — current incident envelope from incident-service.
   * Used by the detail page header so the operator sees status,
   * severity, assignee, etc. alongside the audit-driven timeline
   * (which only carries transitions, not the envelope itself).
   *
   * Same auth + 401-retry-once posture as the POST methods.
   */
  async get(id: string): Promise<Incident> {
    return this.send<Incident>(`/${id}`, "GET");
  }

  /**
   * `POST /:id/acknowledge` — transitions a new incident to
   * `acknowledged`. Throws `IncidentApiError` on 4xx with the canonical
   * code; the caller maps it to the operator-facing message.
   */
  async acknowledge(id: string, body: AcknowledgeIncidentRequest): Promise<Incident> {
    return this.post<Incident>(`/${id}/acknowledge`, body);
  }

  /** `POST /:id/assign` — `acknowledged` → `assigned`. */
  async assign(id: string, body: AssignIncidentRequest): Promise<Incident> {
    return this.post<Incident>(`/${id}/assign`, body);
  }

  /** `POST /:id/start_progress` — `assigned` → `in_progress`. */
  async startProgress(id: string, body: StartProgressIncidentRequest): Promise<Incident> {
    return this.post<Incident>(`/${id}/start_progress`, body);
  }

  /** `POST /:id/resolve` — `in_progress` (or `escalated`) → `resolved`. */
  async resolve(id: string, body: ResolveIncidentRequest): Promise<Incident> {
    return this.post<Incident>(`/${id}/resolve`, body);
  }

  /** `POST /:id/escalate` — any active state → `escalated`. */
  async escalate(id: string, body: EscalateIncidentRequest): Promise<Incident> {
    return this.post<Incident>(`/${id}/escalate`, body);
  }

  /** `POST /:id/archive` — `resolved` → `archived` (terminal). */
  async archive(id: string, body: ArchiveIncidentRequest): Promise<Incident> {
    return this.post<Incident>(`/${id}/archive`, body);
  }

  /** `POST /:id/reject` — any non-terminal → `rejected` (terminal). */
  async reject(id: string, body: RejectIncidentRequest): Promise<Incident> {
    return this.post<Incident>(`/${id}/reject`, body);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, "POST", body);
  }

  /**
   * Shared fetch helper. Builds the bearer header from the
   * tokenProvider, delegates to the configured fetchFn, and runs
   * the canonical 401 → onUnauthorized → retry-once pattern. The
   * POST methods + the new GET share this so the auth posture is
   * identical no matter the method.
   */
  private async send<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const fire = async (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token) headers["authorization"] = `Bearer ${token}`;
      return this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    };

    let res = await fire(this.tokenProvider());
    if (res.status === 401 && this.onUnauthorized) {
      // Lazy refresh: ask the auth store to swap the access token,
      // then retry exactly once. A second 401 falls through to the
      // caller — the global guard will then bounce to /login.
      const fresh = await this.onUnauthorized();
      if (fresh) {
        res = await fire(fresh);
      }
    }
    if (!res.ok) {
      let parsed: IncidentApiErrorBody;
      try {
        parsed = (await res.json()) as IncidentApiErrorBody;
      } catch {
        parsed = {
          error: { code: "UNKNOWN", message: `request failed with status ${res.status}` },
        };
      }
      throw new IncidentApiError(res.status, parsed);
    }
    return (await res.json()) as T;
  }
}
