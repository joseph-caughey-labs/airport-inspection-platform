import { type Logger } from "@aip/logger";
import { type PgPool } from "@aip/postgres-client";
import { type RedisClient } from "@aip/redis-client";
import { Counter, type Registry } from "prom-client";

export interface OutboxWorkerOptions {
  pool: PgPool;
  redis: RedisClient;
  logger: Logger;
  registry: Registry;
  /** Poll interval in ms. Default 250 (4Hz). */
  intervalMs?: number;
  /** Max rows fetched per poll. Default 100. */
  batchSize?: number;
  /** Override the clock (for tests). Default Date.now. */
  now?: () => number;
}

interface OutboxRow {
  id: string;
  channel: string;
  payload: string;
  attempts: number;
}

let publishedCounter: Counter<"channel"> | undefined;
let failedCounter: Counter<"channel"> | undefined;

function registerMetricsOnce(registry: Registry) {
  if (!publishedCounter) {
    publishedCounter = new Counter({
      name: "outbox_published_total",
      help: "Outbox rows successfully published to Redis.",
      labelNames: ["channel"] as const,
      registers: [registry],
    });
  }
  if (!failedCounter) {
    failedCounter = new Counter({
      name: "outbox_publish_failures_total",
      help: "Outbox rows whose Redis publish threw on a tick.",
      labelNames: ["channel"] as const,
      registers: [registry],
    });
  }
  return { publishedCounter, failedCounter };
}

export function _resetOutboxMetricsForTests(): void {
  publishedCounter = undefined;
  failedCounter = undefined;
}

/**
 * Drains the `event_outbox` table on a fixed interval and publishes
 * each row to its target Redis channel. Marks rows `published_at`
 * after success; increments `attempts` (without publishing) on
 * failure so a downstream alert / future hotfix can detect stuck
 * rows. The next tick retries the same rows naturally.
 *
 * At-least-once semantics. Consumers of the broadcast channel must
 * tolerate duplicates (ws-broadcaster's `last_event_id` resume in
 * T-210 + the sensor_events idempotency_key handle this together).
 */
export class OutboxWorker {
  private readonly opts: Required<Omit<OutboxWorkerOptions, "now">> & { now: () => number };
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(opts: OutboxWorkerOptions) {
    this.opts = {
      pool: opts.pool,
      redis: opts.redis,
      logger: opts.logger,
      registry: opts.registry,
      intervalMs: opts.intervalMs ?? 250,
      batchSize: opts.batchSize ?? 100,
      now: opts.now ?? Date.now,
    };
    registerMetricsOnce(this.opts.registry);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.inFlight) await new Promise((r) => setImmediate(r));
  }

  /** Run one polling cycle. Exposed for deterministic tests. */
  async tick(): Promise<{ published: number; failed: number }> {
    if (this.inFlight) return { published: 0, failed: 0 };
    this.inFlight = true;
    const { publishedCounter: published, failedCounter: failed } = registerMetricsOnce(
      this.opts.registry,
    );
    let publishedN = 0;
    let failedN = 0;
    try {
      const { rows } = await this.opts.pool.query<OutboxRow>(
        `SELECT id, channel, payload, attempts FROM event_outbox
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1`,
        [this.opts.batchSize],
      );
      for (const row of rows) {
        try {
          await this.opts.redis.publish(row.channel, row.payload);
          await this.opts.pool.query(`UPDATE event_outbox SET published_at = now() WHERE id = $1`, [
            row.id,
          ]);
          published.labels(row.channel).inc();
          publishedN++;
        } catch (err) {
          await this.opts.pool.query(
            `UPDATE event_outbox SET attempts = attempts + 1 WHERE id = $1`,
            [row.id],
          );
          failed.labels(row.channel).inc();
          failedN++;
          this.opts.logger.warn(
            {
              outbox_id: row.id,
              channel: row.channel,
              attempts: row.attempts + 1,
              err: err instanceof Error ? err.message : String(err),
            },
            "outbox publish failed; will retry on next tick",
          );
        }
      }
      return { published: publishedN, failed: failedN };
    } finally {
      this.inFlight = false;
    }
  }
}
