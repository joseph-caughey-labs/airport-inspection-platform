import { type Logger } from "@aip/logger";
import { checkHealth, type PgPool } from "@aip/postgres-client";
import Fastify from "fastify";
import type { IncidentEventPublisher } from "./events/index.js";
import { InMemoryIncidentRepository, type IncidentRepository } from "./repository/index.js";
import { registerIncidentRoutes } from "./routes/incidents.js";

export interface BuildAppOptions {
  logger: Logger;
  pool: PgPool;
  /**
   * Override the repository. Defaults to the in-memory implementation
   * — the Postgres-backed repository lands as part of T-404 once the
   * write paths from T-403/T-404 are stable enough for an integration
   * test against a real DB. Until then, REST endpoints serve from
   * memory and the operator UI can still wire up against the same
   * envelope shape.
   */
  repository?: IncidentRepository;
  /**
   * Domain event publisher. The production path wires
   * `RedisIncidentEventPublisher`; tests typically pass
   * `RecordingIncidentEventPublisher` or omit it entirely (the route
   * accepts an undefined publisher and skips event emission).
   */
  events?: IncidentEventPublisher;
}

export async function buildApp({ logger, pool, repository, events }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });
  const repo = repository ?? new InMemoryIncidentRepository();

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const health = await checkHealth(pool);
    if (!health.healthy) {
      return reply.code(503).send({
        status: "unhealthy",
        latency_ms: health.latency_ms,
        ...(health.error ? { error: health.error } : {}),
      });
    }
    return { status: "ready", latency_ms: health.latency_ms };
  });

  registerIncidentRoutes(app, { repository: repo, events });

  return app;
}
