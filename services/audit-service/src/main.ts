import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createPgPool } from "@aip/postgres-client";
import { createRedis } from "@aip/redis-client";
import { buildApp } from "./app.js";
import { AuditChainWriter } from "./chain/writer.js";
import { IncidentTransitionsSubscriber } from "./subscribers/incident-transitions.js";
import { SecurityEventsSubscriber } from "./subscribers/security-events.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "audit-service" });
  const registry = createRegistry({ service: "audit-service" });
  // Three Redis clients: one per psubscribe loop (ioredis enforces
  // a dedicated connection for pattern subscriptions) and one for
  // healthcheck PINGs.
  const redisIncidents = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const redisSecurity = createRedis({
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
  const incidentSubscriber = new IncidentTransitionsSubscriber({
    redis: redisIncidents,
    writer,
    logger,
  });
  await incidentSubscriber.start();
  // T-506 — same writer, second channel pattern.
  const securitySubscriber = new SecurityEventsSubscriber({
    redis: redisSecurity,
    writer,
    logger,
  });
  await securitySubscriber.start();

  const signer = createJwtSigner({
    secret: process.env["JWT_SECRET"] ?? "dev-only-secret-shared-with-api-gateway-32-bytes-min",
    issuer: "aip-api-gateway",
  });

  const app = await buildApp({ logger, redis: redisHealth, pool, registry, signer });
  const port = Number(process.env["PORT"] ?? 3007);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "audit-service ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await Promise.all([incidentSubscriber.stop(), securitySubscriber.stop()]);
    await app.close();
    redisIncidents.disconnect();
    redisSecurity.disconnect();
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
