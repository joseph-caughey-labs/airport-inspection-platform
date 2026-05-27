import { createLogger } from "@aip/logger";
import { createRedis } from "@aip/redis-client";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "ws-broadcaster" });
  const redis = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });

  const app = await buildApp({ logger, redis });
  const port = Number(process.env["PORT"] ?? 3005);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "ws-broadcaster ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await app.close();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("ws-broadcaster fatal startup error:", err);
  process.exit(1);
});
