import { createLogger } from "@aip/logger";
import { createPgPool } from "@aip/postgres-client";
import { createRedis } from "@aip/redis-client";
import { buildApp } from "./app.js";
import { AuditChainWriter } from "./chain/writer.js";
import { IncidentTransitionsSubscriber } from "./subscribers/incident-transitions.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "audit-service" });
  // Two Redis clients: one for the subscriber loop (cannot share
  // with command/PUBLISH usage) and one for healthcheck PINGs.
  const redisSub = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const redisHealth = createRedis({
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

  const writer = new AuditChainWriter(pool);
  const subscriber = new IncidentTransitionsSubscriber({
    redis: redisSub,
    writer,
    logger,
  });
  await subscriber.start();

  const app = await buildApp({ logger, redis: redisHealth, pool });
  const port = Number(process.env["PORT"] ?? 3007);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "audit-service ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await subscriber.stop();
    await app.close();
    redisSub.disconnect();
    redisHealth.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("audit-service fatal startup error:", err);
  process.exit(1);
});
