import { type JwtSigner } from "@aip/auth-jwt";
import { DEFAULT_BODY_LIMIT_BYTES, installHttpSafety } from "@aip/http-safety";
import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import { type PgPool } from "@aip/postgres-client";
import { checkHealth, type RedisClient } from "@aip/redis-client";
import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";
import { ChannelRegistry, FrameHydrator } from "./channels/index.js";
import { registerAirportEventsRoute } from "./routes/airport-events.js";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
  pool: PgPool;
  registry: Registry;
  /** Default hydration size (clients may override via ?hydrate=). */
  hydrationDefaultLimit?: number;
  /**
   * JWT signer used to verify the access token on every WS upgrade
   * (T-504b). Required — there is no auth-disabled mode. Tests
   * construct a test signer and mint a short-lived token for the
   * connection.
   */
  signer: JwtSigner;
}

export interface BuiltApp {
  app: ReturnType<typeof Fastify>;
  channelRegistry: ChannelRegistry;
}

/**
 * Wires the WS service together. The Redis bridge that fans
 * `events.broadcast.*` into the registry is owned by `main.ts` (it
 * needs the dedicated subscriber connection) — `buildApp` stops at
 * the registry boundary so tests can drive dispatch synchronously.
 */
export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const app = Fastify({
    logger: { level: opts.logger.level },
    disableRequestLogging: false,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });

  installHttpSafety(app);
  app.addHook("onRequest", correlationHook());
  installMetrics({ app, registry: opts.registry });
  await app.register(websocketPlugin);

  const channelRegistry = new ChannelRegistry({ registry: opts.registry });
  const hydrator = new FrameHydrator({
    pool: opts.pool,
    ...(opts.hydrationDefaultLimit !== undefined
      ? { defaultLimit: opts.hydrationDefaultLimit }
      : {}),
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const health = await checkHealth(opts.redis);
    if (!health.healthy) {
      return reply.code(503).send({
        status: "unhealthy",
        latency_ms: health.latency_ms,
        ...(health.error ? { error: health.error } : {}),
      });
    }
    return { status: "ready", latency_ms: health.latency_ms };
  });

  // Placeholder echo channel — still useful for verifying the upgrade path through NGINX.
  app.get("/ws/v1/ping", { websocket: true }, (socket) => {
    socket.on("message", (raw: Buffer) => {
      socket.send(`pong:${raw.toString()}`);
    });
  });

  registerAirportEventsRoute(app, {
    registry: channelRegistry,
    hydrator,
    logger: opts.logger,
    signer: opts.signer,
  });

  return { app, channelRegistry };
}
