import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncidentApi, IncidentApiError } from "~/utils/incident-api";

const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const OPERATOR = "33333333-3333-3333-3333-333333333333";
const INCIDENT_ID = "22222222-2222-2222-2222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STORED_INCIDENT = {
  id: INCIDENT_ID,
  airport_id: AIRPORT,
  severity: "high" as const,
  status: "acknowledged" as const,
  title: "FOD on RWY 10L",
  acknowledged_by: OPERATOR,
  acknowledged_at: "2026-05-29T10:00:00.000Z",
  created_at: "2026-05-29T09:00:00.000Z",
  updated_at: "2026-05-29T10:00:00.000Z",
};

describe("IncidentApi.acknowledge — happy path", () => {
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchFn = vi.fn();
  });

  it("POSTs the canonical body to /incidents/:id/acknowledge", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED_INCIDENT));
    const api = new IncidentApi({ fetchFn });
    await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`/incidents/${INCIDENT_ID}/acknowledge`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ operator_id: OPERATOR });
  });

  it("returns the parsed Incident envelope", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED_INCIDENT));
    const api = new IncidentApi({ fetchFn });
    const result = await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    expect(result.status).toBe("acknowledged");
    expect(result.acknowledged_by).toBe(OPERATOR);
  });

  it("threads the optional note through into the request body", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED_INCIDENT));
    const api = new IncidentApi({ fetchFn });
    await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR, note: "tower confirmed" });
    const init = fetchFn.mock.calls[0]![1];
    expect(JSON.parse(init.body)).toEqual({
      operator_id: OPERATOR,
      note: "tower confirmed",
    });
  });

  it("prefixes the configured baseUrl", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED_INCIDENT));
    const api = new IncidentApi({ fetchFn, baseUrl: "http://api.example" });
    await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    expect(fetchFn.mock.calls[0]![0]).toBe(
      `http://api.example/incidents/${INCIDENT_ID}/acknowledge`,
    );
  });
});

describe("IncidentApi.acknowledge — error paths", () => {
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchFn = vi.fn();
  });

  it("throws IncidentApiError with code + status on 4xx", async () => {
    fetchFn.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "ILLEGAL_TRANSITION",
          message: "illegal transition from acknowledged via acknowledge",
          details: { from: "acknowledged", command: "acknowledge" },
        },
      }),
    );
    const api = new IncidentApi({ fetchFn });
    try {
      await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
      expect.fail("expected IncidentApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(IncidentApiError);
      const apiErr = err as IncidentApiError;
      expect(apiErr.code).toBe("ILLEGAL_TRANSITION");
      expect(apiErr.status).toBe(409);
      expect(apiErr.details?.from).toBe("acknowledged");
    }
  });

  it("falls back to UNKNOWN code when the server returned non-json on error", async () => {
    fetchFn.mockResolvedValue(new Response("not json", { status: 500 }));
    const api = new IncidentApi({ fetchFn });
    try {
      await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
      expect.fail("expected IncidentApiError");
    } catch (err) {
      const apiErr = err as IncidentApiError;
      expect(apiErr.code).toBe("UNKNOWN");
      expect(apiErr.status).toBe(500);
    }
  });

  it("returns 404 path threads through", async () => {
    fetchFn.mockResolvedValue(
      jsonResponse(404, {
        error: { code: "INCIDENT_NOT_FOUND", message: "missing" },
      }),
    );
    const api = new IncidentApi({ fetchFn });
    try {
      await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
      expect.fail("expected error");
    } catch (err) {
      expect((err as IncidentApiError).code).toBe("INCIDENT_NOT_FOUND");
      expect((err as IncidentApiError).status).toBe(404);
    }
  });
});
