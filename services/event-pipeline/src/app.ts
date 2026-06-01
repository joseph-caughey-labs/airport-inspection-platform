import { DEFAULT_BODY_LIMIT_BYTES, installHttpSafety } from "@aip/http-safety";
import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import { checkHealth as checkPostgres, type PgPool } from "@aip/postgres-client";
import { checkHealth as checkRedis, type RedisClient } from "@aip/redis-client";
import Fastify from "fastify";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
  pool: PgPool;
  registry: Registry;
}

/**
 * Service shell. /health, /ready (both deps), /metrics.
 *
 * Phase 2 (T-205) adds Redis consumers wired in `main.ts`; this file
 * stays Fastify-only because the consumers run outside the HTTP
 * request scope on the same process.
 */
export async function buildApp({ logger, redis, pool, registry }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });

  installHttpSafety(app);
  app.addHook("onRequest", correlationHook());
  installMetrics({ app, registry });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const [redisHealth, pgHealth] = await Promise.all([checkRedis(redis), checkPostgres(pool)]);
    const healthy = redisHealth.healthy && pgHealth.healthy;
    if (!healthy) {
      return reply.code(503).send({
        status: "unhealthy",
        redis: redisHealth,
        postgres: pgHealth,
      });
    }
    return { status: "ready", redis: redisHealth, postgres: pgHealth };
  });

  return app;
}
