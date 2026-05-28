import { createLogger } from "@aip/logger";
import { describe, expect, it, vi } from "vitest";
import { createPersistHandler } from "../../../services/event-pipeline/src/persistence/index.js";

const logger = createLogger({ service: "persist-test", level: "fatal" });

const validEnvelope = JSON.stringify({
  event_id: "11111111-2222-3333-4444-555555555555",
  event_type: "sensor.frame.captured",
  schema_version: "v1",
  source: { service: "sensor-gateway" },
  timestamp: "2026-05-28T10:00:00.000Z",
  idempotency_key: "frame:CAM-RWY10L-01-00000001",
  payload: {
    sensor_id: "CAM-RWY10L-01",
    sensor_type: "camera",
    frame_id: "CAM-RWY10L-01-00000001",
    captured_at: "2026-05-28T10:00:00.000Z",
    geo: { lat: 37.6213, lng: -122.379, alt_m: 4 },
    metadata: { width: 1920, height: 1080 },
  },
});

/**
 * Fake pool that records SQL/params for every query and returns the
 * canned responses we configure. `connect()` returns a client that
 * routes through the same query function and tracks transaction state.
 */
function makeFakePool(opts?: { insertRowCount?: number; failAt?: string }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const insertRowCount = opts?.insertRowCount ?? 1;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, ...(params ? { params } : {}) });
    if (opts?.failAt && sql.includes(opts.failAt)) {
      throw new Error(`forced fail at ${opts.failAt}`);
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO sensor_events")) {
      return { rows: [], rowCount: insertRowCount };
    }
    if (sql.includes("INSERT INTO event_outbox")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(async () => client);
  return { pool: { connect } as unknown as import("pg").Pool, calls, client };
}

describe("createPersistHandler — happy path", () => {
  it("INSERTs both sensor_events and event_outbox in a single transaction", async () => {
    const { pool, calls } = makeFakePool({ insertRowCount: 1 });
    const h = createPersistHandler({ pool });
    await h.handle(validEnvelope, { logger });
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.some((s) => s.includes("INSERT INTO sensor_events"))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO event_outbox"))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
  });

  it("uses the configured channel prefix + airport id", async () => {
    const { pool, calls } = makeFakePool();
    const h = createPersistHandler({
      pool,
      broadcastChannelPrefix: "events.broadcast",
      defaultAirportId: "11111111-1111-1111-1111-aaaaaaaaaaaa",
    });
    await h.handle(validEnvelope, { logger });
    const outboxInsert = calls.find((c) => c.sql.includes("INSERT INTO event_outbox"));
    expect(outboxInsert?.params?.[0]).toBe("events.broadcast.11111111-1111-1111-1111-aaaaaaaaaaaa");
  });

  it("uses idempotency_key from the envelope (falls back to event_id)", async () => {
    const { pool, calls } = makeFakePool();
    const h = createPersistHandler({ pool });
    await h.handle(validEnvelope, { logger });
    const sensorInsert = calls.find((c) => c.sql.includes("INSERT INTO sensor_events"));
    // idempotency_key is the 11th param (1-indexed in SQL, 10th in array).
    expect(sensorInsert?.params?.[10]).toBe("frame:CAM-RWY10L-01-00000001");
  });
});

describe("createPersistHandler — duplicate suppression at DB tier", () => {
  it("skips outbox insert when sensor_events ON CONFLICT DO NOTHING returns 0 rows", async () => {
    const { pool, calls } = makeFakePool({ insertRowCount: 0 });
    const h = createPersistHandler({ pool });
    await h.handle(validEnvelope, { logger });
    expect(calls.some((c) => c.sql.includes("INSERT INTO event_outbox"))).toBe(false);
    expect(calls[calls.length - 1]?.sql).toBe("COMMIT");
  });
});

describe("createPersistHandler — error paths", () => {
  it("rolls back when sensor_events INSERT throws", async () => {
    const { pool, calls } = makeFakePool({ failAt: "INSERT INTO sensor_events" });
    const h = createPersistHandler({ pool });
    await expect(h.handle(validEnvelope, { logger })).rejects.toThrow(/forced fail/);
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("BEGIN");
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });

  it("throws typed error on malformed JSON", async () => {
    const { pool } = makeFakePool();
    const h = createPersistHandler({ pool });
    await expect(h.handle("{not json", { logger })).rejects.toThrow(/malformed JSON/);
  });

  it("throws typed error on schema violation", async () => {
    const { pool } = makeFakePool();
    const h = createPersistHandler({ pool });
    const bad = JSON.parse(validEnvelope);
    bad.payload.sensor_id = "lowercase-bad";
    await expect(h.handle(JSON.stringify(bad), { logger })).rejects.toThrow(/schema violation/);
  });
});

describe("createPersistHandler — identity", () => {
  it("registers on the canonical sensor.frame.captured channel", () => {
    const h = createPersistHandler({ pool: {} as import("pg").Pool });
    expect(h.channel).toBe("sensor.frame.captured");
    expect(h.name).toBe("sensor-frames");
  });
});
