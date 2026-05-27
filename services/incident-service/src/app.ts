import { type Logger } from "@aip/logger";
import { checkHealth, type PgPool } from "@aip/postgres-client";
import Fastify from "fastify";

export interface BuildAppOptions {
  logger: Logger;
  pool: PgPool;
}

/**
 * Shell only — state machine, lifecycle endpoints, and audit emission
 * land in T-401..T-404. The placeholder /incidents endpoint returns an
 * empty list so the operator UI can wire up without 404s.
 */
export async function buildApp({ logger, pool }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const health = await checkHealth(pool);
    if (!health.healthy) {
      return reply.code(503).send({
        status: "unhealthy",
        latency_ms: health.latency_ms,
        ...(health.error ? { error: health.error } : {}),
      });
    }
    return { status: "ready", latency_ms: health.latency_ms };
  });

  app.get("/incidents", async () => ({ items: [], total: 0 }));

  return app;
}
