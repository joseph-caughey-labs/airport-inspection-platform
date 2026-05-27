import { type Logger } from "@aip/logger";
import { checkHealth, type RedisClient } from "@aip/redis-client";
import Fastify from "fastify";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
}

/**
 * Shell only — real simulators + fault injection land in T-201..T-204.
 * Today this service has a healthy connection to Redis and exposes
 * health/ready so the rest of the stack can depend on it.
 */
export async function buildApp({ logger, redis }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const health = await checkHealth(redis);
    if (!health.healthy) {
      return reply.code(503).send({
        status: "unhealthy",
        latency_ms: health.latency_ms,
        ...(health.error ? { error: health.error } : {}),
      });
    }
    return { status: "ready", latency_ms: health.latency_ms };
  });

  return app;
}
