import { DEFAULT_BODY_LIMIT_BYTES, installHttpSafety } from "@aip/http-safety";
import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import { checkHealth, type RedisClient } from "@aip/redis-client";
import Fastify from "fastify";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
  /** Prom registry. When omitted, /metrics is not exposed. */
  registry?: Registry;
}

/**
 * Shell only — real simulators + fault injection land in T-201..T-204.
 * Today this service has a healthy connection to Redis and exposes
 * health/ready so the rest of the stack can depend on it.
 */
export async function buildApp({ logger, redis, registry }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });

  installHttpSafety(app);
  app.addHook("onRequest", correlationHook());
  if (registry) installMetrics({ app, registry });

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
