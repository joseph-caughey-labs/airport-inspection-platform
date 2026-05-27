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
 * Shell only — Redis consumers, dedup, prioritization, ordering, and
 * persistence all land in T-205..T-208. /ready probes both Redis and
 * Postgres so depending services know when both deps are reachable.
 */
export async function buildApp({ logger, redis, pool }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

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
