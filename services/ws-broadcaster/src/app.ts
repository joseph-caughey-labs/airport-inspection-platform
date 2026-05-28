import { type Logger } from "@aip/logger";
import { checkHealth, type RedisClient } from "@aip/redis-client";
import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
}

/**
 * Shell only. One placeholder WS route (`/ws/v1/ping`) so clients can
 * confirm the upgrade handshake works through NGINX. Real per-airport
 * channels, presence, and the `last_event_id` resume protocol land in
 * T-209/T-210.
 */
export async function buildApp({ logger, redis }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  await app.register(websocketPlugin);

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

  // Placeholder echo channel — proves the upgrade path works end-to-end.
  app.get("/ws/v1/ping", { websocket: true }, (socket) => {
    socket.on("message", (raw: Buffer) => {
      socket.send(`pong:${raw.toString()}`);
    });
  });

  return app;
}
