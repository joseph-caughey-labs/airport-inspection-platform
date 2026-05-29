import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { describe, expect, it, vi } from "vitest";
import { AiDetectionBridge } from "../../../services/event-pipeline/src/ai-detections/index.js";

const logger = createLogger({ service: "bridge-test", level: "fatal" });
function reg() {
  return createRegistry({ service: "bridge-test", collectDefault: false });
}

const DEFAULT_AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const OTHER_AIRPORT = "11111111-1111-1111-1111-bbbbbbbbbbbb";

function fakeRedis() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => 1),
    punsubscribe: vi.fn(async () => 1),
  } as unknown as import("ioredis").default;
}

function fakePool(opts?: { failAt?: string }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, ...(params ? { params } : {}) });
    if (opts?.failAt && sql.includes(opts.failAt)) {
      throw new Error(`forced fail at ${opts.failAt}`);
    }
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query } as unknown as import("pg").Pool, calls };
}

const validDetection = JSON.stringify({
  event_id: "11111111-2222-3333-4444-555555555555",
  event_type: "ai.detection.fod.emitted",
  schema_version: "v1",
  source: { service: "ai-inference" },
  timestamp: "2026-05-28T10:00:00.000Z",
  idempotency_key: "detection:CAM-1:F-1:fod",
  payload: {
    detection_id: "det-1",
    sensor_id: "CAM-RWY10L-01",
    frame_id: "F-1",
    detection_class: "fod",
    confidence: 0.87,
    severity_hint: "critical",
    captured_at: "2026-05-28T10:00:00.000Z",
  },
});

describe("AiDetectionBridge — construction", () => {
  it("requires defaultAirportId", () => {
    expect(
      () =>
        new AiDetectionBridge({
          redis: fakeRedis(),
          pool: fakePool().pool,
          logger,
          registry: reg(),
        } as unknown as ConstructorParameters<typeof AiDetectionBridge>[0]),
    ).toThrow(/defaultAirportId/);
  });
});

describe("AiDetectionBridge — handleMessage", () => {
  it("inserts a broadcast outbox row with the default airport channel", async () => {
    const { pool, calls } = fakePool();
    const b = new AiDetectionBridge({
      redis: fakeRedis(),
      pool,
      logger,
      registry: reg(),
      defaultAirportId: DEFAULT_AIRPORT,
    });
    await b.handleMessage("ai.detection.fod.emitted", validDetection);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/INSERT INTO event_outbox/);
    expect(calls[0]?.params?.[0]).toBe(`events.broadcast.${DEFAULT_AIRPORT}`);
    expect(calls[0]?.params?.[1]).toBe(validDetection);
  });

  it("uses payload.airport_id when present (sensor → airport mapping override)", async () => {
    const { pool, calls } = fakePool();
    const b = new AiDetectionBridge({
      redis: fakeRedis(),
      pool,
      logger,
      registry: reg(),
      defaultAirportId: DEFAULT_AIRPORT,
    });
    const parsed = JSON.parse(validDetection) as { payload: { airport_id?: string } };
    parsed.payload.airport_id = OTHER_AIRPORT;
    await b.handleMessage("ai.detection.fod.emitted", JSON.stringify(parsed));
    expect(calls[0]?.params?.[0]).toBe(`events.broadcast.${OTHER_AIRPORT}`);
  });

  it("drops malformed JSON without throwing", async () => {
    const { pool, calls } = fakePool();
    const promReg = reg();
    const b = new AiDetectionBridge({
      redis: fakeRedis(),
      pool,
      logger,
      registry: promReg,
      defaultAirportId: DEFAULT_AIRPORT,
    });
    await expect(b.handleMessage("ai.detection.fod.emitted", "{not json")).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    const text = await promReg.metrics();
    expect(text).toMatch(/ai_detection_invalid_total[^\n]*reason="malformed_payload"/);
  });

  it("drops events with the wrong event_type prefix", async () => {
    const { pool, calls } = fakePool();
    const b = new AiDetectionBridge({
      redis: fakeRedis(),
      pool,
      logger,
      registry: reg(),
      defaultAirportId: DEFAULT_AIRPORT,
    });
    const wrong = JSON.parse(validDetection) as { event_type: string };
    wrong.event_type = "incident.created";
    await b.handleMessage("foo", JSON.stringify(wrong));
    expect(calls).toEqual([]);
  });

  it("drops envelopes without a payload object", async () => {
    const { pool, calls } = fakePool();
    const b = new AiDetectionBridge({
      redis: fakeRedis(),
      pool,
      logger,
      registry: reg(),
      defaultAirportId: DEFAULT_AIRPORT,
    });
    await b.handleMessage(
      "ai.detection.fod.emitted",
      JSON.stringify({ event_type: "ai.detection.fod.emitted" }),
    );
    expect(calls).toEqual([]);
  });

  it("emits the bridged counter with airport label on success", async () => {
    const { pool } = fakePool();
    const promReg = reg();
    const b = new AiDetectionBridge({
      redis: fakeRedis(),
      pool,
      logger,
      registry: promReg,
      defaultAirportId: DEFAULT_AIRPORT,
    });
    await b.handleMessage("ai.detection.fod.emitted", validDetection);
    const text = await promReg.metrics();
    expect(text).toMatch(/ai_detection_bridged_total[^\n]*airport="11111111/);
  });

  it("propagates a postgres insert failure to the caller", async () => {
    const { pool } = fakePool({ failAt: "INSERT INTO event_outbox" });
    const b = new AiDetectionBridge({
      redis: fakeRedis(),
      pool,
      logger,
      registry: reg(),
      defaultAirportId: DEFAULT_AIRPORT,
    });
    await expect(b.handleMessage("ai.detection.fod.emitted", validDetection)).rejects.toThrow(
      /forced fail/,
    );
  });
});

describe("AiDetectionBridge — lifecycle", () => {
  it("psubscribes on start and punsubscribes on stop", async () => {
    const fake = fakeRedis();
    const { pool } = fakePool();
    const b = new AiDetectionBridge({
      redis: fake,
      pool,
      logger,
      registry: reg(),
      defaultAirportId: DEFAULT_AIRPORT,
      pattern: "ai.detection.*.emitted",
    });
    await b.start();
    expect(fake.psubscribe).toHaveBeenCalledWith("ai.detection.*.emitted");
    expect(fake.on).toHaveBeenCalledWith("pmessage", expect.any(Function));
    await b.stop();
    expect(fake.punsubscribe).toHaveBeenCalledWith("ai.detection.*.emitted");
    expect(fake.off).toHaveBeenCalledWith("pmessage", expect.any(Function));
  });

  it("start is idempotent", async () => {
    const fake = fakeRedis();
    const { pool } = fakePool();
    const b = new AiDetectionBridge({
      redis: fake,
      pool,
      logger,
      registry: reg(),
      defaultAirportId: DEFAULT_AIRPORT,
    });
    await b.start();
    await b.start();
    expect(fake.psubscribe).toHaveBeenCalledTimes(1);
  });
});
