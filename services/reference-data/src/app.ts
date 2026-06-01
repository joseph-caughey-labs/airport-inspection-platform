import { requireRole, verifyJwtHook, type JwtSigner } from "@aip/auth-jwt";
import { schema } from "@aip/db-schema";
import { DEFAULT_BODY_LIMIT_BYTES, installHttpSafety } from "@aip/http-safety";
import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import { checkHealth, type PgPool } from "@aip/postgres-client";
import { rolesFor } from "@aip/shared-contracts";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import Fastify from "fastify";

export interface BuildAppOptions {
  logger: Logger;
  pool: PgPool;
  /** Prom registry. When omitted, /metrics is not exposed. */
  registry?: Registry;
  /**
   * JWT signer used to verify the Authorization header on every
   * protected route (T-504c). Required — there is no auth-disabled
   * mode. /health, /ready, /metrics remain public.
   */
  signer: JwtSigner;
}

/**
 * Build the Fastify app. We don't pass the pino logger to Fastify's
 * `loggerInstance` option because the type interface there diverges
 * from pino's full type and causes generic mismatches against our
 * strict TS config. Application-level logs still flow through our
 * shared `@aip/logger`; Fastify's per-request logs use its default
 * pino instance configured below.
 */
export async function buildApp({ logger, pool, registry, signer }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });

  installHttpSafety(app);
  app.addHook("onRequest", correlationHook());
  app.addHook("onRequest", verifyJwtHook({ signer }));
  if (registry) installMetrics({ app, registry });
  const db = drizzle(pool, { schema });

  // `reference.read` covers everything in the reference catalog —
  // airports, runways, sensors, SOP baselines. Operators and
  // reviewers both need it; admin is implicit.
  const readGuard = { preHandler: requireRole(...rolesFor("reference.read")) };

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

  app.get("/airports", readGuard, async () => {
    const rows = await db.select().from(schema.airports);
    return { items: rows, total: rows.length };
  });

  app.get<{ Querystring: { airport_id?: string } }>("/runways", readGuard, async (req) => {
    const { airport_id } = req.query;
    const rows = airport_id
      ? await db.select().from(schema.runways).where(eq(schema.runways.airportId, airport_id))
      : await db.select().from(schema.runways);
    return { items: rows, total: rows.length };
  });

  app.get<{
    Querystring: { airport_id?: string; type?: string };
  }>("/sensors", readGuard, async (req) => {
    const { airport_id, type } = req.query;
    const conditions = [
      airport_id ? eq(schema.sensors.airportId, airport_id) : undefined,
      type ? eq(schema.sensors.type, type) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const rows = conditions.length
      ? await db
          .select()
          .from(schema.sensors)
          .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : await db.select().from(schema.sensors);
    return { items: rows, total: rows.length };
  });

  app.get("/sop-baseline", readGuard, async () => {
    // T-118 lands real values seeded from data/seed/reference/sop-baseline.json.
    // Until then, expose a stable placeholder so consumers can wire up.
    return {
      snowbank: {
        max_height_cm: 240,
        runway_setback_min_m: 6,
        taxiway_setback_min_m: 3,
      },
      fod: {
        location_severity: {
          runway_active: "critical",
          runway_inactive: "high",
          taxiway: "medium",
          apron: "low",
        },
      },
      crack: {
        severity_bands_mm: { low: 6, medium: 12, high: 25 },
      },
    };
  });

  return app;
}
