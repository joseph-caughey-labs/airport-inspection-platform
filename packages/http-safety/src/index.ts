/**
 * Shared Fastify safety primitives (T-505).
 *
 *   - `DEFAULT_BODY_LIMIT_BYTES` — passed to `Fastify({ bodyLimit })`
 *     by every service. Fastify's own default is 1 MiB; ours is
 *     tighter because none of our routes accept anything that large.
 *   - `safeErrorHandler` — normalizes Fastify's native error shapes
 *     into `ErrorResponse` from `@aip/shared-contracts`. Never leaks
 *     stack traces or upstream error strings on 5xx. 4xx errors keep
 *     the original message so validation feedback reaches the
 *     caller.
 *   - `safeNotFoundHandler` — returns the same `ErrorResponse`
 *     envelope on a 404 (Fastify's default is plain text).
 *   - `installHttpSafety` — convenience wrapper that registers both
 *     handlers in one call. Services call this immediately after
 *     `Fastify(...)`.
 *
 * The handlers were lifted from `services/api-gateway/src/errors/handler.ts`
 * so every service shares the same envelope and downstream clients
 * have one error shape to parse.
 */
import { ErrorCode, type ErrorResponse } from "@aip/shared-contracts";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// `@aip/logger`'s `correlationHook` stamps `request_id` onto every
// request. Match the augmentation here so this package can be
// typechecked without importing the logger — TS merges the
// identical declaration.
declare module "fastify" {
  interface FastifyRequest {
    request_id: string;
  }
}

/**
 * 256 KiB. None of our routes accept image uploads or bulk imports
 * today. Increase per-route via Fastify's `{ bodyLimit }` route
 * option when something legitimately needs more.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;

export function safeErrorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const status = err.statusCode ?? 500;

  let code: ErrorResponse["error"]["code"];
  if (err.validation) code = ErrorCode.VALIDATION_FAILED;
  else if (status === 401) code = ErrorCode.UNAUTHORIZED;
  else if (status === 403) code = ErrorCode.FORBIDDEN;
  else if (status === 404) code = ErrorCode.NOT_FOUND;
  else if (status === 409) code = ErrorCode.CONFLICT;
  else if (status === 413) code = ErrorCode.PAYLOAD_TOO_LARGE;
  else if (status === 415) code = ErrorCode.VALIDATION_FAILED;
  else if (status === 422) code = ErrorCode.UNPROCESSABLE;
  else if (status === 429) code = ErrorCode.RATE_LIMITED;
  else if (status >= 500) code = ErrorCode.INTERNAL_ERROR;
  else code = ErrorCode.VALIDATION_FAILED;

  const body: ErrorResponse = {
    error: {
      code,
      // Don't echo internal error messages on 5xx — they may carry
      // stack traces, file paths, or upstream details. 4xx messages
      // are user-actionable (validation feedback, etc.).
      message: status >= 500 ? "internal server error" : err.message,
      ...(req.request_id ? { correlation_id: req.request_id } : {}),
    },
  };

  void reply.status(status).send(body);
}

export function safeNotFoundHandler(req: FastifyRequest, reply: FastifyReply): void {
  const body: ErrorResponse = {
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `route ${req.method} ${req.url} not found`,
      ...(req.request_id ? { correlation_id: req.request_id } : {}),
    },
  };
  void reply.status(404).send(body);
}

/**
 * Registers both `safeErrorHandler` and `safeNotFoundHandler` on
 * `app`. Idempotent in spirit — Fastify will replace any previously
 * registered handler.
 */
export function installHttpSafety(app: FastifyInstance): void {
  app.setErrorHandler(safeErrorHandler);
  app.setNotFoundHandler(safeNotFoundHandler);
}
