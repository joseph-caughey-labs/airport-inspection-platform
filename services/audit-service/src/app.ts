import { type Logger } from "@aip/logger";
import { checkHealth as checkPostgres, type PgPool } from "@aip/postgres-client";
import { checkHealth as checkRedis, type RedisClient } from "@aip/redis-client";
import Fastify from "fastify";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
  pool: PgPool;
}

/**
 * Shell only — hash-chain INSERT, Redis subscribers, and lineage
 * queries land in T-412. The placeholder /audit/events endpoint
 * returns an empty envelope so callers can wire up.
 */
export async function buildApp({ logger, redis, pool }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const [redisHealth, pgHealth] = await Promise.all([checkRedis(redis), checkPostgres(pool)]);
    if (!redisHealth.healthy || !pgHealth.healthy) {
      return reply.code(503).send({
        status: "unhealthy",
        redis: redisHealth,
        postgres: pgHealth,
      });
    }
    return { status: "ready", redis: redisHealth, postgres: pgHealth };
  });

  app.get("/audit/events", async () => ({ items: [], total: 0 }));

  return app;
}
