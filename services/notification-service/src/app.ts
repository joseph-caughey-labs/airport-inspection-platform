import { type Logger } from "@aip/logger";
import { checkHealth, type RedisClient } from "@aip/redis-client";
import Fastify from "fastify";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
}

/**
 * Shell only. The channel registry advertises which delivery channels
 * exist; actual implementations (in-app via ws-broadcaster, webhook
 * with retry/DLQ, email stub) land in T-413.
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

  app.get("/channels", async () => ({
    channels: [
      { name: "in_app", status: "stub" },
      { name: "webhook", status: "stub" },
      { name: "email", status: "stub" },
    ],
  }));

  return app;
}
