import { ErrorCode, type ErrorResponse } from "@aip/shared-contracts";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * Canonical error handler. Maps Fastify's native error shapes (validation,
 * 404, generic) onto `ErrorResponse` from `@aip/shared-contracts`. Never
 * includes a stack trace; sensitive paths are not echoed.
 */
export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  const status = err.statusCode ?? 500;

  let code: ErrorResponse["error"]["code"];
  if (err.validation) code = ErrorCode.VALIDATION_FAILED;
  else if (status === 401) code = ErrorCode.UNAUTHORIZED;
  else if (status === 403) code = ErrorCode.FORBIDDEN;
  else if (status === 404) code = ErrorCode.NOT_FOUND;
  else if (status === 409) code = ErrorCode.CONFLICT;
  else if (status === 413) code = ErrorCode.PAYLOAD_TOO_LARGE;
  else if (status === 422) code = ErrorCode.UNPROCESSABLE;
  else if (status === 429) code = ErrorCode.RATE_LIMITED;
  else if (status >= 500) code = ErrorCode.INTERNAL_ERROR;
  else code = ErrorCode.VALIDATION_FAILED;

  const body: ErrorResponse = {
    error: {
      code,
      message: status >= 500 ? "internal server error" : err.message,
      ...(req.request_id ? { correlation_id: req.request_id } : {}),
    },
  };

  void reply.status(status).send(body);
}

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply): void {
  const body: ErrorResponse = {
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `route ${req.method} ${req.url} not found`,
      ...(req.request_id ? { correlation_id: req.request_id } : {}),
    },
  };
  void reply.status(404).send(body);
}
