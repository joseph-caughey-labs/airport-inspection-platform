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

  it("POSTs the canonical body to /api/v1/incidents/:id/acknowledge (default api-gateway base)", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED_INCIDENT));
    const api = new IncidentApi({ fetchFn });
    await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`/api/v1/incidents/${INCIDENT_ID}/acknowledge`);
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
    expect(fetchFn.mock.calls[0]![0]).toBe(`http://api.example/${INCIDENT_ID}/acknowledge`);
  });
});

describe("IncidentApi — other transitions (T-404)", () => {
  // The 6 remaining lifecycle methods all share `post<Incident>()`
  // under the hood, so per-method coverage is just: (a) URL + body
  // shape are right and (b) the parsed envelope flows back. The
  // shared error-path coverage in `acknowledge — error paths`
  // already exercises the post() helper.
  let fetchFn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchFn = vi.fn();
  });

  it("assign POSTs to /assign with operator_id + assignee_id", async () => {
    fetchFn.mockResolvedValue(
      jsonResponse(200, { ...STORED_INCIDENT, status: "assigned", assigned_to: OPERATOR }),
    );
    const api = new IncidentApi({ fetchFn });
    const result = await api.assign(INCIDENT_ID, {
      operator_id: OPERATOR,
      assignee_id: OPERATOR,
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`/api/v1/incidents/${INCIDENT_ID}/assign`);
    expect(JSON.parse(init.body)).toEqual({ operator_id: OPERATOR, assignee_id: OPERATOR });
    expect(result.status).toBe("assigned");
  });

  it("startProgress POSTs to /start_progress", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, { ...STORED_INCIDENT, status: "in_progress" }));
    const api = new IncidentApi({ fetchFn });
    await api.startProgress(INCIDENT_ID, { operator_id: OPERATOR });
    expect(fetchFn.mock.calls[0]![0]).toBe(`/api/v1/incidents/${INCIDENT_ID}/start_progress`);
  });

  it("resolve POSTs to /resolve with resolution_summary", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, { ...STORED_INCIDENT, status: "resolved" }));
    const api = new IncidentApi({ fetchFn });
    await api.resolve(INCIDENT_ID, {
      operator_id: OPERATOR,
      resolution_summary: "FOD removed",
    });
    const init = fetchFn.mock.calls[0]![1];
    expect(JSON.parse(init.body)).toEqual({
      operator_id: OPERATOR,
      resolution_summary: "FOD removed",
    });
  });

  it("escalate POSTs to /escalate with reason", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, { ...STORED_INCIDENT, status: "escalated" }));
    const api = new IncidentApi({ fetchFn });
    await api.escalate(INCIDENT_ID, { operator_id: OPERATOR, reason: "sla_breach" });
    const init = fetchFn.mock.calls[0]![1];
    expect(JSON.parse(init.body)).toEqual({ operator_id: OPERATOR, reason: "sla_breach" });
  });

  it("archive POSTs to /archive", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, { ...STORED_INCIDENT, status: "archived" }));
    const api = new IncidentApi({ fetchFn });
    const result = await api.archive(INCIDENT_ID, { operator_id: OPERATOR });
    expect(fetchFn.mock.calls[0]![0]).toBe(`/api/v1/incidents/${INCIDENT_ID}/archive`);
    expect(result.status).toBe("archived");
  });

  it("reject POSTs to /reject with reason", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, { ...STORED_INCIDENT, status: "rejected" }));
    const api = new IncidentApi({ fetchFn });
    await api.reject(INCIDENT_ID, { operator_id: OPERATOR, reason: "duplicate" });
    expect(fetchFn.mock.calls[0]![0]).toBe(`/api/v1/incidents/${INCIDENT_ID}/reject`);
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body)).toEqual({
      operator_id: OPERATOR,
      reason: "duplicate",
    });
  });

  it("propagates IncidentApiError on 409 from any transition", async () => {
    fetchFn.mockResolvedValue(
      jsonResponse(409, {
        error: { code: "ILLEGAL_TRANSITION", message: "x", details: { from: "new" } },
      }),
    );
    const api = new IncidentApi({ fetchFn });
    await expect(
      api.resolve(INCIDENT_ID, { operator_id: OPERATOR, resolution_summary: "done" }),
    ).rejects.toBeInstanceOf(IncidentApiError);
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

describe("IncidentApi.get — detail page read", () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchFn = vi.fn();
  });

  it("GETs /api/v1/incidents/:id (default api-gateway base) without a body", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED_INCIDENT));
    const api = new IncidentApi({ fetchFn });
    const result = await api.get(INCIDENT_ID);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`/api/v1/incidents/${INCIDENT_ID}`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("content-type");
    expect(result.id).toBe(INCIDENT_ID);
    expect(result.status).toBe("acknowledged");
  });

  it("attaches Bearer when the tokenProvider returns a string", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED_INCIDENT));
    const api = new IncidentApi({ fetchFn, tokenProvider: () => "access-1" });
    await api.get(INCIDENT_ID);
    expect(fetchFn.mock.calls[0]![1].headers).toMatchObject({
      authorization: "Bearer access-1",
    });
  });

  it("retries once on 401 with the fresh token from onUnauthorized", async () => {
    fetchFn
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "unauthorized", message: "x" } }))
      .mockResolvedValueOnce(jsonResponse(200, STORED_INCIDENT));
    const onUnauthorized = vi.fn().mockResolvedValue("access-2");
    const api = new IncidentApi({
      fetchFn,
      tokenProvider: () => "access-1",
      onUnauthorized,
    });
    const result = await api.get(INCIDENT_ID);
    expect(result.id).toBe(INCIDENT_ID);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![1].headers.authorization).toBe("Bearer access-2");
  });

  it("throws IncidentApiError on 404 with INCIDENT_NOT_FOUND", async () => {
    fetchFn.mockResolvedValue(
      jsonResponse(404, { error: { code: "INCIDENT_NOT_FOUND", message: "missing" } }),
    );
    const api = new IncidentApi({ fetchFn });
    await expect(api.get(INCIDENT_ID)).rejects.toBeInstanceOf(IncidentApiError);
  });
});
