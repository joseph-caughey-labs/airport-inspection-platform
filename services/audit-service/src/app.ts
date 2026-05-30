import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import { checkHealth as checkPostgres, type PgPool } from "@aip/postgres-client";
import { checkHealth as checkRedis, type RedisClient } from "@aip/redis-client";
import Fastify from "fastify";
import { GENESIS_PREV_HASH, verifyChain } from "./chain/hash.js";

export interface BuildAppOptions {
  logger: Logger;
  redis: RedisClient;
  pool: PgPool;
  /** Prom registry. When omitted, /metrics is not exposed (used by
   * unit tests that don't care about scrape surface). */
  registry?: Registry;
  /** Max events returned per list page. Default 100. */
  listPageLimit?: number;
  /** Max events scanned by the verify endpoint per call. Default 1000. */
  verifyMaxRows?: number;
}

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_VERIFY_MAX_ROWS = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AuditRow {
  seq: string;
  event_id: string;
  occurred_at: string;
  source: string;
  event_type: string;
  actor_user_id: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string | null;
  entry_hash: string;
  correlation_id: string | null;
  rationale: string | null;
}

/**
 * Read paths for the append-only audit log. Write path is the
 * Redis subscriber → AuditChainWriter (started from main.ts); this
 * file is the HTTP surface for operators + post-incident reviews:
 *
 *   GET /audit/events                 — paginated list (newest first)
 *   GET /audit/events/:event_id       — single envelope by event_id
 *   GET /audit/lineage/:subject_id    — all events for an incident /
 *                                       validation run, oldest first
 *   POST /audit/verify                — verify the chain over a range
 *                                       (T-412 + ADR 0010 detection
 *                                       layer; complements REVOKE
 *                                       UPDATE/DELETE as prevention)
 */
export async function buildApp(opts: BuildAppOptions) {
  const { logger, redis, pool } = opts;
  const listLimit = opts.listPageLimit ?? DEFAULT_LIST_LIMIT;
  const verifyMax = opts.verifyMaxRows ?? DEFAULT_VERIFY_MAX_ROWS;

  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  app.addHook("onRequest", correlationHook());
  if (opts.registry) installMetrics({ app, registry: opts.registry });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const [redisHealth, pgHealth] = await Promise.all([checkRedis(redis), checkPostgres(pool)]);
    if (!redisHealth.healthy || !pgHealth.healthy) {
      return reply.code(503).send({
        status: "unhealthy",
        redis: redisHealth,
        postgres: pgHealth,
      });
    }
    return { status: "ready", redis: redisHealth, postgres: pgHealth };
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    "/audit/events",
    async (req, reply) => {
      const limit = clampLimit(req.query.limit, listLimit);
      let where = "";
      const params: unknown[] = [];
      if (req.query.cursor) {
        const cursor = decodeCursor(req.query.cursor);
        if (cursor === undefined) {
          return reply.code(400).send(errorEnvelope("INVALID_CURSOR", "cursor is malformed"));
        }
        where = "WHERE seq < $1";
        params.push(cursor);
      }
      params.push(limit + 1);
      const rows = (
        await pool.query<AuditRow>(
          `SELECT seq::text AS seq, event_id, occurred_at, source, event_type,
                  actor_user_id, subject_id, payload, prev_hash, entry_hash,
                  correlation_id, rationale
             FROM audit_events
             ${where}
             ORDER BY seq DESC
             LIMIT $${params.length}`,
          params,
        )
      ).rows;
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const next_cursor = hasMore ? encodeCursor(items[items.length - 1]!.seq) : null;
      return { items, next_cursor };
    },
  );

  app.get<{ Params: { event_id: string } }>("/audit/events/:event_id", async (req, reply) => {
    if (!UUID_RE.test(req.params.event_id)) {
      return reply.code(400).send(errorEnvelope("INVALID_ID", "event_id must be a uuid"));
    }
    const result = await pool.query<AuditRow>(
      `SELECT seq::text AS seq, event_id, occurred_at, source, event_type,
              actor_user_id, subject_id, payload, prev_hash, entry_hash,
              correlation_id, rationale
         FROM audit_events
         WHERE event_id = $1`,
      [req.params.event_id],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send(errorEnvelope("AUDIT_EVENT_NOT_FOUND", "no event with that id"));
    }
    return row;
  });

  app.get<{ Params: { subject_id: string } }>("/audit/lineage/:subject_id", async (req) => {
    const rows = (
      await pool.query<AuditRow>(
        `SELECT seq::text AS seq, event_id, occurred_at, source, event_type,
                actor_user_id, subject_id, payload, prev_hash, entry_hash,
                correlation_id, rationale
           FROM audit_events
           WHERE subject_id = $1
           ORDER BY seq ASC`,
        [req.params.subject_id],
      )
    ).rows;
    return { subject_id: req.params.subject_id, items: rows, total: rows.length };
  });

  app.post<{ Body: { from_seq?: string; to_seq?: string } }>(
    "/audit/verify",
    async (req, reply) => {
      const body = req.body ?? {};
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (body.from_seq) {
        params.push(body.from_seq);
        conditions.push(`seq >= $${params.length}`);
      }
      if (body.to_seq) {
        params.push(body.to_seq);
        conditions.push(`seq <= $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(verifyMax);
      const rows = (
        await pool.query<AuditRow>(
          `SELECT seq::text AS seq, event_id, occurred_at, source, event_type,
                  actor_user_id, subject_id, payload, prev_hash, entry_hash,
                  correlation_id, rationale
             FROM audit_events
             ${where}
             ORDER BY seq ASC
             LIMIT $${params.length}`,
          params,
        )
      ).rows;
      if (rows.length === verifyMax) {
        // Surface that the range may have been truncated so the
        // caller knows to page through with from_seq.
        return reply.code(400).send(
          errorEnvelope("VERIFY_RANGE_TOO_LARGE", `range exceeds ${verifyMax} rows; narrow it`, {
            scanned: rows.length,
          }),
        );
      }
      const seedPrev = body.from_seq
        ? await chainTipBefore(pool, body.from_seq)
        : GENESIS_PREV_HASH;
      const broken = verifyChain(
        rows.map((r) => ({
          prev_hash: r.prev_hash ?? seedPrev,
          entry_hash: r.entry_hash,
          row: {
            event_id: r.event_id,
            occurred_at: r.occurred_at,
            source: r.source,
            event_type: r.event_type,
            actor_user_id: r.actor_user_id,
            subject_id: r.subject_id,
            payload: r.payload,
            correlation_id: r.correlation_id,
            rationale: r.rationale,
          },
        })),
      );
      return {
        verified: broken === null,
        rows_scanned: rows.length,
        broken_at: broken,
      };
    },
  );

  return app;
}

function clampLimit(raw: string | undefined, defaultLimit: number): number {
  if (raw === undefined) return defaultLimit;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultLimit;
  return Math.min(Math.floor(n), defaultLimit);
}

function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ seq }), "utf8").toString("base64url");
}

function decodeCursor(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { seq?: unknown };
    if (typeof parsed.seq !== "string") return undefined;
    return parsed.seq;
  } catch {
    return undefined;
  }
}

async function chainTipBefore(pool: PgPool, fromSeq: string): Promise<string> {
  const r = await pool.query<{ entry_hash: string }>(
    `SELECT entry_hash FROM audit_events WHERE seq < $1 ORDER BY seq DESC LIMIT 1`,
    [fromSeq],
  );
  return r.rows[0]?.entry_hash ?? GENESIS_PREV_HASH;
}

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}
