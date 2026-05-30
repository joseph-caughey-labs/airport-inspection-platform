/**
 * @aip/http-safety unit tests (T-505).
 *
 * Tests the handlers directly with mock req/reply rather than
 * standing up a real Fastify — vitest's pnpm-resolution path for
 * `import Fastify from "fastify"` from a centralized __TEST__/
 * file trips the same CJS-interop trap T-501 hit. The handlers
 * are pure functions of (err, req, reply), so unit-level coverage
 * here + integration coverage at every service's `app.test.ts`
 * (which goes through a real `buildApp`) covers the same surface.
 */
import { ErrorCode } from "@aip/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BODY_LIMIT_BYTES,
  safeErrorHandler,
  safeNotFoundHandler,
} from "../../../packages/http-safety/src/index.js";

interface MockReply {
  statusCode: number;
  body: unknown;
  status(code: number): MockReply;
  send(payload: unknown): void;
}

function mockReply(): MockReply {
  const reply: MockReply = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
    },
  };
  return reply;
}

function mockReq(overrides: Partial<{ method: string; url: string; request_id: string }> = {}) {
  return {
    method: overrides.method ?? "GET",
    url: overrides.url ?? "/x",
    request_id: overrides.request_id,
  } as unknown as Parameters<typeof safeErrorHandler>[1];
}

describe("safeErrorHandler — status → code mapping", () => {
  const cases = [
    [400, ErrorCode.VALIDATION_FAILED],
    [401, ErrorCode.UNAUTHORIZED],
    [403, ErrorCode.FORBIDDEN],
    [404, ErrorCode.NOT_FOUND],
    [409, ErrorCode.CONFLICT],
    [413, ErrorCode.PAYLOAD_TOO_LARGE],
    [415, ErrorCode.VALIDATION_FAILED],
    [422, ErrorCode.UNPROCESSABLE],
    [429, ErrorCode.RATE_LIMITED],
    [500, ErrorCode.INTERNAL_ERROR],
    [502, ErrorCode.INTERNAL_ERROR],
  ] as const;

  it.each(cases)("status %i → code %s", (status, expectedCode) => {
    const reply = mockReply();
    const err = Object.assign(new Error("anything"), { statusCode: status });
    safeErrorHandler(err as never, mockReq() as never, reply as never);
    expect(reply.statusCode).toBe(status);
    expect((reply.body as { error: { code: string } }).error.code).toBe(expectedCode);
  });
});

describe("safeErrorHandler — message scrubbing", () => {
  it("echoes the original message on 4xx so validation feedback reaches the caller", () => {
    const reply = mockReply();
    const err = Object.assign(new Error("email must be a string"), { statusCode: 400 });
    safeErrorHandler(err as never, mockReq() as never, reply as never);
    expect((reply.body as { error: { message: string } }).error.message).toBe(
      "email must be a string",
    );
  });

  it("replaces the message on 5xx — never echoes stack traces or upstream details", () => {
    const reply = mockReply();
    const err = Object.assign(new Error("password=hunter2 stack at /etc/secret/key.pem line 42"), {
      statusCode: 500,
    });
    safeErrorHandler(err as never, mockReq() as never, reply as never);
    const body = reply.body as { error: { message: string } };
    expect(body.error.message).toBe("internal server error");
    expect(body.error.message).not.toContain("password");
    expect(body.error.message).not.toContain("/etc/secret");
  });

  it("treats a missing statusCode as 500 (defensive default)", () => {
    const reply = mockReply();
    const err = new Error("oops");
    safeErrorHandler(err as never, mockReq() as never, reply as never);
    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: { code: string; message: string } }).error.code).toBe(
      ErrorCode.INTERNAL_ERROR,
    );
  });

  it("prefers VALIDATION_FAILED when err.validation is set, regardless of status", () => {
    const reply = mockReply();
    const err = Object.assign(new Error("body must have required property 'name'"), {
      statusCode: 400,
      validation: [{ instancePath: "/name", message: "is required" }],
    });
    safeErrorHandler(err as never, mockReq() as never, reply as never);
    expect((reply.body as { error: { code: string } }).error.code).toBe(
      ErrorCode.VALIDATION_FAILED,
    );
  });
});

describe("safeErrorHandler — correlation_id passthrough", () => {
  it("includes correlation_id when req.request_id is set", () => {
    const reply = mockReply();
    const err = Object.assign(new Error("nope"), { statusCode: 401 });
    safeErrorHandler(err as never, mockReq({ request_id: "req-abc-123" }) as never, reply as never);
    expect((reply.body as { error: { correlation_id?: string } }).error.correlation_id).toBe(
      "req-abc-123",
    );
  });

  it("omits correlation_id when there is no request_id (test envs / pre-hook errors)", () => {
    const reply = mockReply();
    const err = Object.assign(new Error("nope"), { statusCode: 401 });
    safeErrorHandler(err as never, mockReq() as never, reply as never);
    expect(reply.body as { error: { correlation_id?: string } }).not.toHaveProperty(
      "error.correlation_id",
    );
  });
});

describe("safeNotFoundHandler", () => {
  it("returns NOT_FOUND envelope with the method + url", () => {
    const reply = mockReply();
    safeNotFoundHandler(
      mockReq({ method: "POST", url: "/no-such-route" }) as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(404);
    const body = reply.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(body.error.message).toBe("route POST /no-such-route not found");
  });

  it("includes correlation_id when request_id is set", () => {
    const reply = mockReply();
    safeNotFoundHandler(mockReq({ request_id: "req-xyz" }) as never, reply as never);
    expect((reply.body as { error: { correlation_id?: string } }).error.correlation_id).toBe(
      "req-xyz",
    );
  });
});

describe("DEFAULT_BODY_LIMIT_BYTES", () => {
  it("is 256 KiB — keeps our existing routes' payloads comfortably under cap", () => {
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(256 * 1024);
  });
});

// Sanity check that `vi.fn()` is wired into this file so future tests
// that need spies have a baseline import.
describe("test-runner sanity", () => {
  it("vitest is responsive", () => {
    const spy = vi.fn();
    spy();
    expect(spy).toHaveBeenCalled();
  });
});
