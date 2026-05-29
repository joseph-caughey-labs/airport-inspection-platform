/**
 * Thin REST client for the incident-service. Lives here (utils/, not
 * stores/) so the pure HTTP shape is unit-testable without spinning
 * up Pinia.
 *
 * Every call returns the canonical envelope from
 * `@aip/shared-contracts` — same shape the OpenAPI spec describes,
 * same shape the operator UI consumes.
 */

import type { AcknowledgeIncidentRequest, Incident } from "@aip/shared-contracts";

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
  /** Base URL for the incident-service. Empty string uses same-origin. */
  baseUrl?: string;
}

export class IncidentApi {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: IncidentApiOptions = {}) {
    // Bind fetch to globalThis so the standard fetch isn't called as a
    // method of `IncidentApi` (which would lose its receiver).
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = opts.baseUrl ?? "";
  }

  /**
   * POST /incidents/:id/acknowledge — transitions a new incident to
   * `acknowledged`. Throws `IncidentApiError` on 4xx with the canonical
   * code; the caller maps it to the operator-facing message.
   */
  async acknowledge(id: string, body: AcknowledgeIncidentRequest): Promise<Incident> {
    return this.post<Incident>(`/incidents/${id}/acknowledge`, body);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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
