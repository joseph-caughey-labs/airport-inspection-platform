import { requireRole, verifyJwtHook, type JwtSigner } from "@aip/auth-jwt";
import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry as PromRegistry } from "@aip/metrics";
import { checkHealth, type RedisClient } from "@aip/redis-client";
import { rolesFor } from "@aip/shared-contracts";
import Fastify from "fastify";
import type { ChannelRegistry } from "./channels/registry.js";
import type { WebhookChannel } from "./channels/webhook.js";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
  registry: ChannelRegistry;
  /**
   * JWT signer used to verify the Authorization header on every
   * protected route (T-504c). Required — there is no auth-disabled
   * mode. /health, /ready, /metrics remain public.
   */
  signer: JwtSigner;
  /** Optional reference to the webhook channel so /deliveries/dlq
   * can surface the in-memory DLQ contents without coupling the
   * registry to the DLQ shape. */
  webhook?: WebhookChannel;
  /** Prom registry. When omitted, /metrics is not exposed. The
   * channel registry uses its own internal counters; this is the
   * shared scrape surface for the platform's standard RED
   * metrics. */
  promRegistry?: PromRegistry;
}

export async function buildApp({
  logger,
  redis,
  registry,
  signer,
  webhook,
  promRegistry,
}: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  app.addHook("onRequest", correlationHook());
  app.addHook("onRequest", verifyJwtHook({ signer }));
  if (promRegistry) installMetrics({ app, registry: promRegistry });

  // All read paths share `notification.read` — operators see the
  // channels they trigger, reviewers oversee delivery health + DLQ
  // contents. The destructive replay path (T-?? later) will gate on
  // `notification.replay_dlq` (reviewer only).
  const readGuard = { preHandler: requireRole(...rolesFor("notification.read")) };

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

  app.get("/channels", readGuard, async () => ({ channels: registry.status() }));

  app.get<{ Querystring: { limit?: string } }>("/deliveries", readGuard, async (req) => {
    const limit = parseLimit(req.query.limit, registry.recentDeliveries.length);
    return { items: registry.recentDeliveries.slice(0, limit) };
  });

  app.get("/deliveries/dlq", readGuard, async () => ({
    items: webhook?.dlq ?? [],
  }));

  return app;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), fallback);
}
