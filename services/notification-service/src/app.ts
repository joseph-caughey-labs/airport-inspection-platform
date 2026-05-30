import { correlationHook, type Logger } from "@aip/logger";
import { checkHealth, type RedisClient } from "@aip/redis-client";
import Fastify from "fastify";
import type { ChannelRegistry } from "./channels/registry.js";
import type { WebhookChannel } from "./channels/webhook.js";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
  registry: ChannelRegistry;
  /** Optional reference to the webhook channel so /deliveries/dlq
   * can surface the in-memory DLQ contents without coupling the
   * registry to the DLQ shape. */
  webhook?: WebhookChannel;
}

export async function buildApp({ logger, redis, registry, webhook }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  app.addHook("onRequest", correlationHook());

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

  app.get("/channels", async () => ({ channels: registry.status() }));

  app.get<{ Querystring: { limit?: string } }>("/deliveries", async (req) => {
    const limit = parseLimit(req.query.limit, registry.recentDeliveries.length);
    return { items: registry.recentDeliveries.slice(0, limit) };
  });

  app.get("/deliveries/dlq", async () => ({
    items: webhook?.dlq ?? [],
  }));

  return app;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), fallback);
}
