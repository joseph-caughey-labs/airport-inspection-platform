import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createRedis } from "@aip/redis-client";
import { buildApp } from "./app.js";
import { EmailChannel } from "./channels/email.js";
import { InAppChannel } from "./channels/in-app.js";
import { ChannelRegistry } from "./channels/registry.js";
import { WebhookChannel } from "./channels/webhook.js";
import { IncidentNotificationsSubscriber } from "./subscribers/incident-notifications.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "notification-service" });
  // Three Redis clients: one for the subscriber (pub/sub mode), one
  // for the in-app channel publish, one for healthcheck PINGs.
  const redisSub = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const redisPub = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });
  const redisHealth = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });

  const inApp = new InAppChannel({ redis: redisPub });
  const webhook = new WebhookChannel({
    url: process.env["WEBHOOK_URL"] ?? "",
    eventTypeAllowlist: ["incident.transitioned"],
  });
  const email = new EmailChannel({ logger });
  const registry = new ChannelRegistry({ channels: [inApp, webhook, email] });
  const promRegistry = createRegistry({ service: "notification-service" });

  const subscriber = new IncidentNotificationsSubscriber({
    redis: redisSub,
    registry,
    logger,
  });
  await subscriber.start();

  const app = await buildApp({
    logger,
    redis: redisHealth,
    registry,
    webhook,
    promRegistry,
  });
  const port = Number(process.env["PORT"] ?? 3008);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "notification-service ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await subscriber.stop();
    await app.close();
    redisSub.disconnect();
    redisPub.disconnect();
    redisHealth.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("notification-service fatal startup error:", err);
  process.exit(1);
});
