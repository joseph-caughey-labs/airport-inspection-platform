import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OutboxWorker,
  _resetOutboxMetricsForTests,
} from "../../../services/event-pipeline/src/persistence/index.js";

const logger = createLogger({ service: "outbox-test", level: "fatal" });

afterEach(() => {
  _resetOutboxMetricsForTests();
});

function makeRegistry() {
  return createRegistry({ service: "outbox-test", collectDefault: false });
}

interface OutboxRow {
  id: string;
  channel: string;
  payload: string;
  attempts: number;
}

function makeFakePool(rows: OutboxRow[][]) {
  // `rows` is a queue of result sets — successive SELECT calls return each batch in order.
  let selectIndex = 0;
  const updates: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT id, channel, payload, attempts FROM event_outbox")) {
      const batch = rows[selectIndex++] ?? [];
      return { rows: batch, rowCount: batch.length };
    }
    if (sql.includes("UPDATE event_outbox")) {
      updates.push({ sql, ...(params ? { params } : {}) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as import("pg").Pool, query, updates };
}

function makeRedis(impl?: (channel: string, payload: string) => Promise<number>) {
  const publish = vi.fn(impl ?? (async (_c: string, _p: string) => 1));
  return { redis: { publish } as unknown as import("ioredis").default, publish };
}

describe("OutboxWorker.tick", () => {
  it("publishes unpublished rows and marks them with UPDATE", async () => {
    const { pool, updates } = makeFakePool([
      [
        { id: "1", channel: "events.broadcast.x", payload: '{"a":1}', attempts: 0 },
        { id: "2", channel: "events.broadcast.x", payload: '{"a":2}', attempts: 0 },
      ],
    ]);
    const { redis, publish } = makeRedis();
    const w = new OutboxWorker({ pool, redis, logger, registry: makeRegistry() });
    const result = await w.tick();
    expect(result).toEqual({ published: 2, failed: 0 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(2);
    expect(updates[0]?.sql).toMatch(
      /UPDATE event_outbox SET published_at = now\(\) WHERE id = \$1/,
    );
  });

  it("increments attempts on publish failure (no published_at update)", async () => {
    const { pool, updates } = makeFakePool([
      [{ id: "5", channel: "events.broadcast.x", payload: "{}", attempts: 1 }],
    ]);
    const { redis } = makeRedis(async () => {
      throw new Error("connection refused");
    });
    const w = new OutboxWorker({ pool, redis, logger, registry: makeRegistry() });
    const result = await w.tick();
    expect(result).toEqual({ published: 0, failed: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toMatch(/SET attempts = attempts \+ 1/);
  });

  it("processes a mix of success and failure in one batch", async () => {
    const { pool } = makeFakePool([
      [
        { id: "1", channel: "ok", payload: "{}", attempts: 0 },
        { id: "2", channel: "bad", payload: "{}", attempts: 0 },
        { id: "3", channel: "ok", payload: "{}", attempts: 0 },
      ],
    ]);
    let calls = 0;
    const { redis } = makeRedis(async (channel) => {
      calls++;
      if (channel === "bad") throw new Error("nope");
      return 1;
    });
    const w = new OutboxWorker({ pool, redis, logger, registry: makeRegistry() });
    const result = await w.tick();
    expect(result).toEqual({ published: 2, failed: 1 });
    expect(calls).toBe(3);
  });

  it("returns {0, 0} when there are no unpublished rows", async () => {
    const { pool } = makeFakePool([[]]);
    const { redis, publish } = makeRedis();
    const w = new OutboxWorker({ pool, redis, logger, registry: makeRegistry() });
    const result = await w.tick();
    expect(result).toEqual({ published: 0, failed: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it("emits outbox_published_total counter on success", async () => {
    const { pool } = makeFakePool([
      [{ id: "1", channel: "events.broadcast.x", payload: "{}", attempts: 0 }],
    ]);
    const { redis } = makeRedis();
    const reg = makeRegistry();
    const w = new OutboxWorker({ pool, redis, logger, registry: reg });
    await w.tick();
    const out = await reg.metrics();
    expect(out).toMatch(/outbox_published_total[^\n]*channel="events.broadcast.x"/);
  });

  it("emits outbox_publish_failures_total counter on failure", async () => {
    const { pool } = makeFakePool([
      [{ id: "1", channel: "events.broadcast.x", payload: "{}", attempts: 0 }],
    ]);
    const { redis } = makeRedis(async () => {
      throw new Error("nope");
    });
    const reg = makeRegistry();
    const w = new OutboxWorker({ pool, redis, logger, registry: reg });
    await w.tick();
    const out = await reg.metrics();
    expect(out).toMatch(/outbox_publish_failures_total[^\n]*channel="events.broadcast.x"/);
  });

  it("respects the configured batchSize via the LIMIT parameter", async () => {
    const { pool, query } = makeFakePool([[]]);
    const { redis } = makeRedis();
    const w = new OutboxWorker({
      pool,
      redis,
      logger,
      registry: makeRegistry(),
      batchSize: 7,
    });
    await w.tick();
    const selectCall = query.mock.calls.find((c) =>
      (c[0] as string).includes("SELECT id, channel, payload, attempts"),
    );
    expect(selectCall?.[1]).toEqual([7]);
  });
});

describe("OutboxWorker — concurrent tick guard", () => {
  it("a second tick called while the first is running returns immediately with zeros", async () => {
    let release: (() => void) | undefined;
    const slowPool = {
      query: vi.fn(
        async () =>
          new Promise<{ rows: OutboxRow[]; rowCount: number }>((resolve) => {
            release = () => resolve({ rows: [], rowCount: 0 });
          }),
      ),
    } as unknown as import("pg").Pool;
    const { redis } = makeRedis();
    const w = new OutboxWorker({
      pool: slowPool,
      redis,
      logger,
      registry: makeRegistry(),
    });
    const first = w.tick();
    const second = await w.tick();
    expect(second).toEqual({ published: 0, failed: 0 });
    release?.();
    await first;
  });
});
