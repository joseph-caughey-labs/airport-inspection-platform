import { randomUUID } from "node:crypto";
import { withContext } from "@aip/logger";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    request_id: string;
  }
}

const REQUEST_ID_HEADER = "x-request-id";
const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Attach a `request_id` to every request (generated when the caller
 * does not supply `x-request-id`), echo it on the response, and enter
 * an `@aip/logger` context so every log line in this request's scope
 * carries the id automatically.
 *
 * `x-correlation-id` is propagated when present, generated otherwise
 * — used to thread a single logical operation across services.
 */
export async function requestId(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const incomingRequestId = req.headers[REQUEST_ID_HEADER];
  const incomingCorrelationId = req.headers[CORRELATION_ID_HEADER];

  const request_id =
    (typeof incomingRequestId === "string" && incomingRequestId.length > 0
      ? incomingRequestId
      : undefined) ?? randomUUID();
  const correlation_id =
    (typeof incomingCorrelationId === "string" && incomingCorrelationId.length > 0
      ? incomingCorrelationId
      : undefined) ?? randomUUID();

  req.request_id = request_id;
  reply.header(REQUEST_ID_HEADER, request_id);
  reply.header(CORRELATION_ID_HEADER, correlation_id);

  // Enter the log context for the lifetime of the request. Fastify's
  // onRequest hook runs once per request and the value returned is
  // awaited; the context applies to subsequent handlers in the chain.
  await new Promise<void>((resolve) => {
    withContext({ request_id, correlation_id }, () => resolve());
  });
}
