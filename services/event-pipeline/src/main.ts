import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createPgPool } from "@aip/postgres-client";
import { createRedis } from "@aip/redis-client";
import { buildApp } from "./app.js";
import { ConsumerOrchestrator, RedisSubscriber, sensorFramesHandler } from "./consumers/index.js";
import { DedupStore, withIdempotencyDedup } from "./dedup/index.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "event-pipeline" });
  const registry = createRegistry({ service: "event-pipeline" });

  // ── Two Redis clients: pub/sub requires a dedicated subscriber. ──
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

  // ── Consumers ────────────────────────────────────────────────────
  const orchestrator = new ConsumerOrchestrator({
    registry,
    logger,
    maxConcurrency: Number(process.env["CONSUMER_MAX_CONCURRENCY"] ?? 32),
  });
  const subscriber = new RedisSubscriber({ redis: redisSubscriber, logger });
  subscriber.setDispatcher((handler, raw) =>
    orchestrator.dispatch(handler, raw).then(() => undefined),
  );

  // ── Dedup middleware ─────────────────────────────────────────────
  const dedupStore = new DedupStore({
    windowMs: Number(process.env["DEDUP_WINDOW_MS"] ?? 5_000),
  });
  subscriber.register(withIdempotencyDedup(sensorFramesHandler, { store: dedupStore, registry }));

  const app = await buildApp({ logger, redis, pool, registry });
  const port = Number(process.env["PORT"] ?? 3004);
  await app.listen({ port, host: "0.0.0.0" });

  if (process.env["CONSUMERS_DISABLED"] !== "true") {
    await subscriber.start();
    logger.info("event-pipeline consumers started");
  } else {
    logger.warn("consumers disabled via CONSUMERS_DISABLED");
  }

  logger.info({ port }, "event-pipeline ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await subscriber.stop();
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
  console.error("event-pipeline fatal startup error:", err);
  process.exit(1);
});
