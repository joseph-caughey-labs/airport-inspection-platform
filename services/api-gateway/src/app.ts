import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import Fastify from "fastify";
import { authDecode } from "./auth/middleware.js";
import { errorHandler, notFoundHandler } from "./errors/handler.js";
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
  // correlationHook runs first so authDecode + every downstream
  // handler logs already-tagged lines (request_id + correlation_id
  // merged in via the pino mixin in `@aip/logger`).
  app.addHook("onRequest", correlationHook());
  app.addHook("onRequest", authDecode);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // ── Metrics (T-502) ──────────────────────────────────────────────
  // Wires the RED triple onResponse + registers GET /metrics. Health
  // and scrape paths are excluded from RED so they don't dominate
  // the counters.
  installMetrics({ app, registry });

  // ── Liveness and readiness ───────────────────────────────────────
  // api-gateway has no downstream DB dependency, so /ready is the same
  // as /health for now. Once we proxy to dependent services in T-117+
  // we can extend /ready to probe them.
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));

  // ── API routes ───────────────────────────────────────────────────
  await app.register(pingRoute);

  return app;
}
