/**
 * Canonical correlation/request-id middleware for every Fastify
 * service in the platform.
 *
 * Behavior on each request:
 *
 *   1. Read `x-request-id` and `x-correlation-id` from headers (case-
 *      insensitive per Fastify). Use what the caller supplied;
 *      otherwise generate UUIDv4s.
 *   2. Echo both headers on the response so the next hop / the
 *      operator browser sees them.
 *   3. Enter an `@aip/logger` context for the rest of the request
 *      via `enterContext()`. Subsequent handlers in the chain see
 *      the same context — the pino `mixin` automatically merges
 *      `request_id` + `correlation_id` into every log line emitted
 *      while the request is in flight.
 *
 * Why a factory + addHook rather than a fastify-plugin wrap:
 *   - `app.register(fp(...))` adds an extra build dep and a
 *     CJS-interop tripwire when Vitest tries to inline-optimize
 *     fastify's CJS internals.
 *   - The hook is the entire contract — no decorators, no shared
 *     state. A plain async function added via `addHook("onRequest")`
 *     matches the existing auth middleware style in api-gateway and
 *     keeps the consumer's wiring obvious.
 *
 * Why a centralized factory anyway:
 *   - `enterContext` (vs the previous broken `withContext` +
 *     Promise dance) is easy to get wrong; centralising it removes
 *     the trap from every service.
 *   - The `FastifyRequest` augmentation for `request_id` +
 *     `correlation_id` lives in one place.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { enterContext } from "./context.js";

declare module "fastify" {
  interface FastifyRequest {
    request_id: string;
    correlation_id: string;
  }
}

export interface CorrelationPluginOptions {
  /** Header that carries the request id. Default `x-request-id`. */
  requestIdHeader?: string;
  /** Header that carries the correlation id. Default `x-correlation-id`. */
  correlationIdHeader?: string;
}

const DEFAULT_REQUEST_ID_HEADER = "x-request-id";
const DEFAULT_CORRELATION_ID_HEADER = "x-correlation-id";

export type CorrelationHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Build the `onRequest` hook. Register on each Fastify service via:
 *
 *   app.addHook("onRequest", correlationHook());
 */
export function correlationHook(opts: CorrelationPluginOptions = {}): CorrelationHook {
  const reqHeader = (opts.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER).toLowerCase();
  const corrHeader = (opts.correlationIdHeader ?? DEFAULT_CORRELATION_ID_HEADER).toLowerCase();

  return async (req, reply) => {
    const incomingRequestId = req.headers[reqHeader];
    const incomingCorrelationId = req.headers[corrHeader];

    const ctx = enterContext({
      ...(typeof incomingRequestId === "string" && incomingRequestId.length > 0
        ? { request_id: incomingRequestId }
        : {}),
      ...(typeof incomingCorrelationId === "string" && incomingCorrelationId.length > 0
        ? { correlation_id: incomingCorrelationId }
        : {}),
    });

    req.request_id = ctx.request_id;
    req.correlation_id = ctx.correlation_id;
    reply.header(reqHeader, ctx.request_id);
    reply.header(corrHeader, ctx.correlation_id);
  };
}

/**
 * Convenience for services that already use the
 * `await app.register(...)` style. Calls `addHook` under the hood.
 *
 *   await app.register(correlationPlugin);
 *   await app.register(correlationPlugin, { requestIdHeader: "x-trace-id" });
 */
export async function correlationPlugin(
  app: { addHook(name: "onRequest", fn: CorrelationHook): unknown },
  opts: CorrelationPluginOptions = {},
): Promise<void> {
  app.addHook("onRequest", correlationHook(opts));
}
