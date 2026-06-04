import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createPgPool } from "@aip/postgres-client";
import { createRedis } from "@aip/redis-client";
import { buildApp } from "./app.js";
import { RedisIncidentEventPublisher } from "./events/index.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "incident-service" });
  const registry = createRegistry({ service: "incident-service" });
  const pool = createPgPool({
    host: process.env["POSTGRES_HOST"] ?? "postgres",
    port: Number(process.env["POSTGRES_PORT"] ?? 5432),
    user: process.env["POSTGRES_USER"] ?? "airport_ops",
    password: process.env["POSTGRES_PASSWORD"] ?? "",
    database: process.env["POSTGRES_DB"] ?? "airport_inspection",
  });
  // T-412: incident-service publishes `incident.transition.*` on
  // Redis so audit-service + notification-service can subscribe.
  // Without this, transitions land in the DB but never reach the
  // audit chain or operator notifications.
  const redis = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const events = new RedisIncidentEventPublisher({ redis, logger, registry });
  const signer = createJwtSigner({
    secret: process.env["JWT_SECRET"] ?? "dev-only-secret-shared-with-api-gateway-32-bytes-min",
    issuer: "aip-api-gateway",
  });

  const app = await buildApp({ logger, pool, registry, signer, events });
  const port = Number(process.env["PORT"] ?? 3006);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "incident-service ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await app.close();
    redis.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("incident-service fatal startup error:", err);
  process.exit(1);
});
