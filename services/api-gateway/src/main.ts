import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createRedis } from "@aip/redis-client";
import { RedisSecurityEventPublisher } from "@aip/security-events";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "api-gateway" });
  const registry = createRegistry({ service: "api-gateway" });

  // Dedicated Redis client for the security-event publisher
  // (T-506). Separated from the auth signer / directory paths so
  // a Redis hiccup never blocks the auth-decision logic — the
  // publisher swallows errors after logging, never throws.
  const redisPub = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const securityEvents = new RedisSecurityEventPublisher({
    redis: redisPub,
    logger,
    registry,
  });

  const app = await buildApp({ logger, registry, securityEvents });
  const port = Number(process.env["PORT"] ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "api-gateway ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await app.close();
    redisPub.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("api-gateway fatal startup error:", err);
  process.exit(1);
});
