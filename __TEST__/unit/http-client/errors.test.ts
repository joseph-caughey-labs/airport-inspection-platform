import { describe, expect, it } from "vitest";
import { HttpClientError, isRetryableStatus } from "../../../packages/http-client/src/index.js";

describe("isRetryableStatus", () => {
  it("flags 408 and 429 as retryable", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });

  it("flags 5xx as retryable", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it("does not flag other 4xx as retryable", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it("does not flag 2xx or 3xx as retryable", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(204)).toBe(false);
    expect(isRetryableStatus(301)).toBe(false);
  });
});

describe("HttpClientError", () => {
  it("carries the code", () => {
    const err = new HttpClientError("timeout", "boom");
    expect(err.code).toBe("timeout");
    expect(err.message).toBe("boom");
  });

  it("attaches status when provided", () => {
    const err = new HttpClientError("http_500", "server", { status: 500, attempts: 4 });
    expect(err.status).toBe(500);
    expect(err.attempts).toBe(4);
  });

  it("strips the stack trace to avoid leakage", () => {
    const err = new HttpClientError("network", "refused");
    expect(err.stack).toBeUndefined();
  });
});
