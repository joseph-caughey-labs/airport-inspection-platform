/**
 * Auth-wiring tests for IncidentApi (T-504d).
 *
 * The original `incident-api.test.ts` covers route / body shapes
 * untouched; this file pins the Authorization-header + 401-retry
 * behaviour that lands with the JWT rollout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncidentApi, IncidentApiError } from "~/utils/incident-api";

const INCIDENT_ID = "22222222-2222-2222-2222-222222222222";
const OPERATOR = "33333333-3333-3333-3333-333333333333";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STORED = {
  id: INCIDENT_ID,
  airport_id: "11111111-1111-1111-1111-aaaaaaaaaaaa",
  severity: "high",
  status: "acknowledged",
  title: "x",
  acknowledged_by: OPERATOR,
  acknowledged_at: "2026-05-29T10:00:00.000Z",
  created_at: "2026-05-29T09:00:00.000Z",
  updated_at: "2026-05-29T10:00:00.000Z",
};

describe("IncidentApi — Authorization header", () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchFn = vi.fn();
  });

  it("attaches `Bearer <token>` when the tokenProvider returns a string", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED));
    const api = new IncidentApi({ fetchFn, tokenProvider: () => "access-1" });
    await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    const [, init] = fetchFn.mock.calls[0]!;
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer access-1",
    });
  });

  it("omits Authorization when the tokenProvider returns null", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, STORED));
    const api = new IncidentApi({ fetchFn, tokenProvider: () => null });
    await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    const [, init] = fetchFn.mock.calls[0]!;
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("reads the token per-request so a refresh between calls is observed", async () => {
    // Fresh Response per call — bodies are single-use.
    fetchFn.mockImplementation(async () => jsonResponse(200, STORED));
    let token: string | null = "access-1";
    const api = new IncidentApi({ fetchFn, tokenProvider: () => token });
    await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    token = "access-2";
    await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    expect(fetchFn.mock.calls[0]![1].headers.authorization).toBe("Bearer access-1");
    expect(fetchFn.mock.calls[1]![1].headers.authorization).toBe("Bearer access-2");
  });
});

describe("IncidentApi — 401 retry via onUnauthorized", () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchFn = vi.fn();
  });

  it("invokes onUnauthorized on the first 401 and retries with the fresh token", async () => {
    fetchFn
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: "unauthorized", message: "x" } }))
      .mockResolvedValueOnce(jsonResponse(200, STORED));
    const onUnauthorized = vi.fn().mockResolvedValue("access-2");
    const api = new IncidentApi({
      fetchFn,
      tokenProvider: () => "access-1",
      onUnauthorized,
    });
    const res = await api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR });
    expect(res.status).toBe("acknowledged");
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]![1].headers.authorization).toBe("Bearer access-1");
    expect(fetchFn.mock.calls[1]![1].headers.authorization).toBe("Bearer access-2");
  });

  it("does NOT retry when onUnauthorized returns null", async () => {
    fetchFn.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "unauthorized", message: "expired" } }),
    );
    const onUnauthorized = vi.fn().mockResolvedValue(null);
    const api = new IncidentApi({
      fetchFn,
      tokenProvider: () => "access-1",
      onUnauthorized,
    });
    await expect(api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR })).rejects.toBeInstanceOf(
      IncidentApiError,
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not retry when no onUnauthorized callback is wired", async () => {
    fetchFn.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "unauthorized", message: "x" } }),
    );
    const api = new IncidentApi({ fetchFn, tokenProvider: () => "access-1" });
    await expect(api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR })).rejects.toBeInstanceOf(
      IncidentApiError,
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("only retries once — a second 401 surfaces to the caller", async () => {
    fetchFn
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "x" } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "still nope" } }));
    const onUnauthorized = vi.fn().mockResolvedValue("access-2");
    const api = new IncidentApi({
      fetchFn,
      tokenProvider: () => "access-1",
      onUnauthorized,
    });
    await expect(api.acknowledge(INCIDENT_ID, { operator_id: OPERATOR })).rejects.toBeInstanceOf(
      IncidentApiError,
    );
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
