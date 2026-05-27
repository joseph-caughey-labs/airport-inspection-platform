import { type Logger } from "@aip/logger";
import { type Registry } from "@aip/metrics";
import Fastify from "fastify";
import { authDecode } from "./auth/middleware.js";
import { errorHandler, notFoundHandler } from "./errors/handler.js";
import { requestId } from "./middleware/request-id.js";
import { pingRoute } from "./routes/ping.js";

export interface BuildAppOptions {
  logger: Logger;
  registry: Registry;
}

export async function buildApp({ logger, registry }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  // ── Global hooks (order matters) ─────────────────────────────────
  app.addHook("onRequest", requestId);
  app.addHook("onRequest", authDecode);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // ── Liveness and readiness ───────────────────────────────────────
  // api-gateway has no downstream DB dependency, so /ready is the same
  // as /health for now. Once we proxy to dependent services in T-117+
  // we can extend /ready to probe them.
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));

  // ── Metrics ──────────────────────────────────────────────────────
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  // ── API routes ───────────────────────────────────────────────────
  await app.register(pingRoute);

  return app;
}
