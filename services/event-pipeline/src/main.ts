import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createPgPool } from "@aip/postgres-client";
import { createRedis } from "@aip/redis-client";
import { AiDetectionBridge } from "./ai-detections/index.js";
import { buildApp } from "./app.js";
import { ConsumerOrchestrator, RedisSubscriber } from "./consumers/index.js";
import { DedupStore, withIdempotencyDedup } from "./dedup/index.js";
import { OutboxWorker, createPersistHandler } from "./persistence/index.js";
import { ReplayQueue, WatermarkTracker, withPrioritization } from "./prioritization/index.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "event-pipeline" });
  const registry = createRegistry({ service: "event-pipeline" });

  // ── Redis clients ────────────────────────────────────────────────
  // Three clients on purpose:
  //   - `redis` is the publish/cmd path (used by the outbox worker).
  //   - `redisSubscriber` owns the sensor-frame channel subscription.
  //   - `redisAiSubscriber` owns the AI-detection pattern subscription
  //     (ioredis forbids mixing patterns with command traffic).
  const redis = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const redisSubscriber = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const redisAiSubscriber = createRedis({
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

  // ── Consumer orchestrator ────────────────────────────────────────
  const orchestrator = new ConsumerOrchestrator({
    registry,
    logger,
    maxConcurrency: Number(process.env["CONSUMER_MAX_CONCURRENCY"] ?? 32),
  });
  const subscriber = new RedisSubscriber({ redis: redisSubscriber, logger });
  subscriber.setDispatcher((handler, raw) =>
    orchestrator.dispatch(handler, raw).then(() => undefined),
  );

  // ── Pipeline composition (outside-in): dedup → prioritize → persist ─
  const dedupStore = new DedupStore({
    windowMs: Number(process.env["DEDUP_WINDOW_MS"] ?? 5_000),
  });
  const watermark = new WatermarkTracker({
    toleranceMs: Number(process.env["WATERMARK_TOLERANCE_MS"] ?? 30_000),
  });
  const replayQueue = new ReplayQueue({
    maxSize: Number(process.env["REPLAY_QUEUE_MAX"] ?? 1024),
  });

  const persistHandler = createPersistHandler({
    pool,
    broadcastChannelPrefix: process.env["BROADCAST_CHANNEL_PREFIX"] ?? "events.broadcast",
    ...(process.env["DEFAULT_AIRPORT_ID"]
      ? { defaultAirportId: process.env["DEFAULT_AIRPORT_ID"] }
      : {}),
  });
  const prioritized = withPrioritization(persistHandler, {
    watermark,
    replayQueue,
    registry,
  });
  const deduped = withIdempotencyDedup(prioritized, { store: dedupStore, registry });
  subscriber.register(deduped);

  // ── Outbox worker (decoupled publish path) ───────────────────────
  const outboxWorker = new OutboxWorker({
    pool,
    redis,
    logger,
    registry,
    intervalMs: Number(process.env["OUTBOX_INTERVAL_MS"] ?? 250),
    batchSize: Number(process.env["OUTBOX_BATCH_SIZE"] ?? 100),
  });

  // ── AI detection bridge (T-310) ──────────────────────────────────
  // psubscribes to ai.detection.*.emitted and forwards each event into
  // the broadcast outbox so the operator dashboard sees AI detections
  // alongside sensor frames.
  const defaultAirportId = process.env["DEFAULT_AIRPORT_ID"] ?? "";
  const aiDetectionBridge = defaultAirportId
    ? new AiDetectionBridge({
        redis: redisAiSubscriber,
        pool,
        logger,
        registry,
        broadcastChannelPrefix: process.env["BROADCAST_CHANNEL_PREFIX"] ?? "events.broadcast",
        defaultAirportId,
        pattern: process.env["AI_DETECTION_PATTERN"] ?? "ai.detection.*.emitted",
      })
    : undefined;

  const app = await buildApp({ logger, redis, pool, registry });
  const port = Number(process.env["PORT"] ?? 3004);
  await app.listen({ port, host: "0.0.0.0" });

  if (process.env["CONSUMERS_DISABLED"] !== "true") {
    await subscriber.start();
    outboxWorker.start();
    if (aiDetectionBridge) {
      await aiDetectionBridge.start();
      logger.info("ai-detection bridge started");
    } else {
      logger.warn("DEFAULT_AIRPORT_ID unset — ai-detection bridge not started");
    }
    logger.info("event-pipeline consumers + outbox worker started");
  } else {
    logger.warn("consumers disabled via CONSUMERS_DISABLED");
  }

  logger.info({ port }, "event-pipeline ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    if (aiDetectionBridge) await aiDetectionBridge.stop();
    await outboxWorker.stop();
    await subscriber.stop();
    await app.close();
    redis.disconnect();
    redisSubscriber.disconnect();
    redisAiSubscriber.disconnect();
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
