import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  HttpClientError,
  createHttpClient,
} from "../../../packages/http-client/src/index.js";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(overrides: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  return createHttpClient({
    baseUrl: "http://test.local",
    timeoutMs: 100,
    retries: 2,
    retryBackoffMs: 1,
    jitter: false,
    sleep: async () => {},
    ...overrides,
  });
}

describe("createHttpClient — happy path", () => {
  it("returns the response on 2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const client = makeClient({ fetchImpl });
    const res = await client.request("GET", "/x");
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("strips trailing slash from baseUrl and prepends path", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      capturedUrl = String(url);
      return jsonResponse(200);
    });
    const client = makeClient({ baseUrl: "http://test.local/", fetchImpl });
    await client.request("GET", "incidents/abc");
    expect(capturedUrl).toBe("http://test.local/incidents/abc");
  });

  it("serializes body to JSON and sets content-type", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedInit = init;
      return jsonResponse(201);
    });
    const client = makeClient({ fetchImpl });
    await client.request("POST", "/incidents", { body: { hello: "world" } });
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe(JSON.stringify({ hello: "world" }));
    expect((capturedInit?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });
});

describe("createHttpClient — retries", () => {
  it("retries on 503 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient({ fetchImpl });
    const res = await client.request("GET", "/x");
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 (rate-limited)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200));
    const client = makeClient({ fetchImpl });
    const res = await client.request("GET", "/x");
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on network errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(jsonResponse(200));
    const client = makeClient({ fetchImpl });
    const res = await client.request("GET", "/x");
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx (non-retryable)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400));
    const client = makeClient({ fetchImpl });
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      code: "http_400",
      status: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws `exhausted` after all attempts fail", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503));
    const client = makeClient({ fetchImpl, retries: 2 });
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      code: "exhausted",
      attempts: 3,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("createHttpClient — timeout", () => {
  it("aborts and throws `timeout` when request exceeds timeoutMs", async () => {
    const fetchImpl = vi.fn(
      (_u: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const client = makeClient({ fetchImpl, retries: 0, timeoutMs: 10 });
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
  });
});

describe("createHttpClient — circuit breaker integration (T-503)", () => {
  function clientWithBreaker(
    fetchImpl: typeof fetch,
    breakerOpts: { failureThreshold?: number; resetTimeoutMs?: number; now?: () => number } = {},
  ) {
    const breaker = new CircuitBreaker({
      name: "test",
      failureThreshold: breakerOpts.failureThreshold ?? 3,
      resetTimeoutMs: breakerOpts.resetTimeoutMs ?? 1_000,
      ...(breakerOpts.now ? { now: breakerOpts.now } : {}),
    });
    const client = makeClient({ fetchImpl, retries: 0, breaker });
    return { client, breaker };
  }

  it("counts a request as ONE breaker failure when retries are exhausted", async () => {
    // retries=2, threshold=3 → 3 logical failing requests = 6 fetch
    // calls. If the breaker counted per-attempt instead, it would
    // open after the FIRST request's 3rd attempt.
    const fetchImpl = vi.fn(async () => jsonResponse(503));
    const breaker = new CircuitBreaker({ name: "t", failureThreshold: 3 });
    const client = makeClient({ fetchImpl, retries: 2, breaker });

    // First request — 3 fetch calls (1 + 2 retries), exhausts.
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(breaker.getState()).toBe("closed"); // 1 failure logged, threshold 3
  });

  it("opens after `failureThreshold` exhausted requests", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503));
    const { client, breaker } = clientWithBreaker(fetchImpl, { failureThreshold: 2 });

    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    expect(breaker.getState()).toBe("open");
  });

  it("rejects immediately with circuit_open when the breaker is open", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503));
    const { client, breaker } = clientWithBreaker(fetchImpl, { failureThreshold: 1 });

    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    expect(breaker.getState()).toBe("open");
    fetchImpl.mockClear();

    // Second request hits the open breaker — fetch is never called.
    const err = await client.request("GET", "/x").catch((e) => e as HttpClientError);
    expect(err).toBeInstanceOf(HttpClientError);
    expect(err.code).toBe("circuit_open");
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("transitions to half_open after resetTimeoutMs and closes on a success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503));
    let now = 1000;
    const { client, breaker } = clientWithBreaker(fetchImpl, {
      failureThreshold: 1,
      resetTimeoutMs: 500,
      now: () => now,
    });
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    expect(breaker.getState()).toBe("open");

    // Advance the clock past resetTimeoutMs.
    now += 600;
    expect(breaker.getState()).toBe("half_open");

    // Probe succeeds → breaker closes.
    fetchImpl.mockImplementationOnce(async () => jsonResponse(200, { ok: true }));
    const res = await client.request("GET", "/x");
    expect(res.status).toBe(200);
    expect(breaker.getState()).toBe("closed");
  });

  it("a successful request resets the failure counter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503));
    const { client, breaker } = clientWithBreaker(fetchImpl, { failureThreshold: 3 });

    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    expect(breaker.getState()).toBe("closed"); // 2 failures, threshold 3

    fetchImpl.mockImplementationOnce(async () => jsonResponse(200));
    await client.request("GET", "/x");

    // Counter is reset; even after 2 more failures we should still be closed.
    fetchImpl.mockImplementation(async () => jsonResponse(503));
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(HttpClientError);
    expect(breaker.getState()).toBe("closed");
  });
});
