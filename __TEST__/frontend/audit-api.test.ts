/**
 * AuditApi (T-414).
 *
 * Pure HTTP-client tests against a mocked fetch — verifies the
 * read endpoint we use from the timeline composable.
 */
import { describe, expect, it, vi } from "vitest";
import { AuditApi, AuditApiError } from "~/utils/audit-api";

const INCIDENT_ID = "11111111-1111-1111-1111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AuditApi.lineage", () => {
  it("GETs /api/v1/audit/lineage/:id (the default api-gateway base) and returns the parsed envelope", async () => {
    const body = {
      subject_id: INCIDENT_ID,
      items: [
        {
          seq: "1",
          event_id: "ev-1",
          occurred_at: "2026-05-29T10:00:00.000Z",
          source: "incident-service",
          event_type: "incident.transitioned",
          actor_user_id: null,
          subject_id: INCIDENT_ID,
          payload: {},
          prev_hash: null,
          entry_hash: "h",
          correlation_id: null,
          rationale: null,
        },
      ],
      total: 1,
    };
    const fetchFn = vi.fn(async () => jsonResponse(200, body));
    const api = new AuditApi({ fetchFn });
    const result = await api.lineage(INCIDENT_ID);
    expect(fetchFn.mock.calls[0]![0]).toBe(`/api/v1/audit/lineage/${INCIDENT_ID}`);
    expect(result.items).toHaveLength(1);
    expect(result.subject_id).toBe(INCIDENT_ID);
  });

  it("URL-encodes the subject id", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { subject_id: "x", items: [], total: 0 }));
    const api = new AuditApi({ fetchFn });
    await api.lineage("with spaces/and-slashes");
    expect(fetchFn.mock.calls[0]![0]).toBe("/api/v1/audit/lineage/with%20spaces%2Fand-slashes");
  });

  it("prefixes the configured baseUrl", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { subject_id: INCIDENT_ID, items: [], total: 0 }),
    );
    const api = new AuditApi({ fetchFn, baseUrl: "http://audit.local" });
    await api.lineage(INCIDENT_ID);
    expect(fetchFn.mock.calls[0]![0]).toBe(`http://audit.local/lineage/${INCIDENT_ID}`);
  });

  it("throws AuditApiError on non-2xx", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(503, { error: "down" }));
    const api = new AuditApi({ fetchFn });
    await expect(api.lineage(INCIDENT_ID)).rejects.toBeInstanceOf(AuditApiError);
  });
});
