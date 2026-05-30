/**
 * Auth-wiring tests for AuditApi (T-504d). Same shape as
 * `incident-api-auth.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditApi, AuditApiError } from "~/utils/audit-api";

const SUBJECT_ID = "22222222-2222-2222-2222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LINEAGE_OK = { subject_id: SUBJECT_ID, items: [], total: 0 };

describe("AuditApi — Authorization header", () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchFn = vi.fn();
  });

  it("attaches `Bearer <token>` when the tokenProvider returns a string", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, LINEAGE_OK));
    const api = new AuditApi({ fetchFn, tokenProvider: () => "access-1" });
    await api.lineage(SUBJECT_ID);
    const [, init] = fetchFn.mock.calls[0]!;
    expect(init.headers).toMatchObject({ authorization: "Bearer access-1" });
  });

  it("omits Authorization when the tokenProvider returns null", async () => {
    fetchFn.mockResolvedValue(jsonResponse(200, LINEAGE_OK));
    const api = new AuditApi({ fetchFn, tokenProvider: () => null });
    await api.lineage(SUBJECT_ID);
    const [, init] = fetchFn.mock.calls[0]!;
    expect(init.headers).not.toHaveProperty("authorization");
  });
});

describe("AuditApi — 401 retry via onUnauthorized", () => {
  let fetchFn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchFn = vi.fn();
  });

  it("retries with the fresh token on a 401", async () => {
    fetchFn
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "x" } }))
      .mockResolvedValueOnce(jsonResponse(200, LINEAGE_OK));
    const onUnauthorized = vi.fn().mockResolvedValue("access-2");
    const api = new AuditApi({
      fetchFn,
      tokenProvider: () => "access-1",
      onUnauthorized,
    });
    const res = await api.lineage(SUBJECT_ID);
    expect(res).toEqual(LINEAGE_OK);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![1].headers.authorization).toBe("Bearer access-2");
  });

  it("throws AuditApiError if the refresh callback returns null", async () => {
    fetchFn.mockResolvedValueOnce(jsonResponse(401, { error: { message: "x" } }));
    const onUnauthorized = vi.fn().mockResolvedValue(null);
    const api = new AuditApi({
      fetchFn,
      tokenProvider: () => "access-1",
      onUnauthorized,
    });
    await expect(api.lineage(SUBJECT_ID)).rejects.toBeInstanceOf(AuditApiError);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
