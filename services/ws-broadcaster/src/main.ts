import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createPgPool } from "@aip/postgres-client";
import { createRedis } from "@aip/redis-client";
import { buildApp } from "./app.js";
import { RedisBridge } from "./redis-bridge.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "ws-broadcaster" });
  const registry = createRegistry({ service: "ws-broadcaster" });

  // Two Redis clients: pattern-subscribe needs its own connection,
  // separate from any command/publish path we add later.
  const redis = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const redisSubscriber = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });

  const pool = createPgPool({
    host: process.env["POSTGRES_HOST"] ?? "postgres",
    port: Number(process.env["POSTGRES_PORT"] ?? 5432),
    user: process.env["POSTGRES_USER"] ?? "airport_ops",
    password: process.env["POSTGRES_PASSWORD"] ?? "",
    database: process.env["POSTGRES_DB"] ?? "airport_inspection",
  });

  const { app, channelRegistry } = await buildApp({
    logger,
    redis,
    pool,
    registry,
    hydrationDefaultLimit: Number(process.env["WS_HYDRATION_LIMIT"] ?? 50),
  });

  const bridge = new RedisBridge({
    redis: redisSubscriber,
    logger,
    registry,
    channelRegistry,
    pattern: process.env["BROADCAST_PATTERN"] ?? "events.broadcast.*",
    prefix: process.env["BROADCAST_CHANNEL_PREFIX"] ?? "events.broadcast",
  });

  const port = Number(process.env["PORT"] ?? 3005);
  await app.listen({ port, host: "0.0.0.0" });

  if (process.env["BRIDGE_DISABLED"] !== "true") {
    await bridge.start();
  } else {
    logger.warn("redis bridge disabled via BRIDGE_DISABLED");
  }

  logger.info({ port }, "ws-broadcaster ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await bridge.stop();
    await app.close();
    redis.disconnect();
    redisSubscriber.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("ws-broadcaster fatal startup error:", err);
  process.exit(1);
});
