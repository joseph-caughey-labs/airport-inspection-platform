import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, describe, expect, it } from "vitest";
import { type ConsumerHandler } from "../../../services/event-pipeline/src/consumers/index.js";
import {
  ReplayQueue,
  WatermarkTracker,
  _resetPrioritizationMetricsForTests,
  withPrioritization,
} from "../../../services/event-pipeline/src/prioritization/index.js";

const logger = createLogger({ service: "prio-test", level: "fatal" });

afterEach(() => {
  _resetPrioritizationMetricsForTests();
});

function makeRegistry() {
  return createRegistry({ service: "prio-test", collectDefault: false });
}

interface CountingHandler extends ConsumerHandler {
  readonly calls: number;
}

function makeInner(): CountingHandler {
  const state = { calls: 0 };
  return {
    name: "sensor-frames",
    channel: "sensor.frame.captured",
    async handle() {
      state.calls++;
    },
    get calls(): number {
      return state.calls;
    },
  };
}

function envelope(opts: { sensorId: string; capturedAt: string; frameId?: string }) {
  return JSON.stringify({
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "sensor.frame.captured",
    schema_version: "v1",
    source: { service: "sensor-gateway" },
    timestamp: opts.capturedAt,
    payload: {
      sensor_id: opts.sensorId,
      sensor_type: "camera",
      frame_id: opts.frameId ?? `${opts.sensorId}-00000001`,
      captured_at: opts.capturedAt,
      geo: { lat: 37.6213, lng: -122.379 },
      metadata: { width: 1920, height: 1080 },
    },
  });
}

describe("withPrioritization", () => {
  it("passes through an in_order frame", async () => {
    const inner = makeInner();
    const wm = new WatermarkTracker();
    const rq = new ReplayQueue();
    const w = withPrioritization(inner, {
      watermark: wm,
      replayQueue: rq,
      registry: makeRegistry(),
    });
    await w.handle(
      envelope({ sensorId: "CAM-RWY10L-01", capturedAt: "2026-05-28T10:00:00.000Z" }),
      { logger },
    );
    expect(inner.calls).toBe(1);
    expect(rq.size()).toBe(0);
  });

  it("passes through a late_in_window frame and counts it", async () => {
    const inner = makeInner();
    const wm = new WatermarkTracker({ toleranceMs: 10_000 });
    const rq = new ReplayQueue();
    const reg = makeRegistry();
    const w = withPrioritization(inner, { watermark: wm, replayQueue: rq, registry: reg });
    await w.handle(
      envelope({
        sensorId: "CAM-RWY10L-01",
        capturedAt: "2026-05-28T10:00:10.000Z",
        frameId: "f-1",
      }),
      { logger },
    );
    await w.handle(
      envelope({
        sensorId: "CAM-RWY10L-01",
        capturedAt: "2026-05-28T10:00:05.000Z", // 5s late, within 10s tolerance
        frameId: "f-2",
      }),
      { logger },
    );
    expect(inner.calls).toBe(2);
    expect(rq.size()).toBe(0);
    const out = await reg.metrics();
    expect(out).toMatch(/frame_order_total[^\n]*status="late_in_window"[^\n]*\s+1/);
  });

  it("routes a late_beyond_window frame to the replay queue (no inner call)", async () => {
    const inner = makeInner();
    const wm = new WatermarkTracker({ toleranceMs: 5_000 });
    const rq = new ReplayQueue();
    const reg = makeRegistry();
    const w = withPrioritization(inner, { watermark: wm, replayQueue: rq, registry: reg });
    await w.handle(
      envelope({
        sensorId: "CAM-RWY10L-01",
        capturedAt: "2026-05-28T10:00:30.000Z",
        frameId: "f-1",
      }),
      { logger },
    );
    await w.handle(
      envelope({
        sensorId: "CAM-RWY10L-01",
        capturedAt: "2026-05-28T10:00:20.000Z", // 10s late, beyond 5s tolerance
        frameId: "f-2",
      }),
      { logger },
    );
    expect(inner.calls).toBe(1); // only the in_order one
    expect(rq.size()).toBe(1);
    expect(rq.peek()[0]?.key).toBe("CAM-RWY10L-01:f-2");
    const out = await reg.metrics();
    expect(out).toMatch(/frame_order_total[^\n]*status="late_beyond_window"[^\n]*\s+1/);
    expect(out).toMatch(/replay_enqueue_total[^\n]*outcome="accepted"[^\n]*\s+1/);
  });

  it("records frame_priority histogram observations per tier", async () => {
    const inner = makeInner();
    const reg = makeRegistry();
    const w = withPrioritization(inner, {
      watermark: new WatermarkTracker(),
      replayQueue: new ReplayQueue(),
      registry: reg,
    });
    await w.handle(
      envelope({ sensorId: "CAM-RWY10L-01", capturedAt: "2026-05-28T10:00:00.000Z" }),
      { logger },
    );
    const out = await reg.metrics();
    expect(out).toMatch(/frame_priority_bucket[^\n]*tier="critical"/);
  });

  it("propagates parse failures unchanged (orchestrator categorizes errors)", async () => {
    const inner = makeInner();
    const w = withPrioritization(inner, {
      watermark: new WatermarkTracker(),
      replayQueue: new ReplayQueue(),
      registry: makeRegistry(),
    });
    await expect(w.handle("{not json", { logger })).rejects.toThrow();
  });

  it("emits replay_enqueue_total{outcome=dropped} when the queue is over capacity", async () => {
    const inner = makeInner();
    const wm = new WatermarkTracker({ toleranceMs: 5_000 });
    const rq = new ReplayQueue({ maxSize: 1 });
    const reg = makeRegistry();
    const w = withPrioritization(inner, { watermark: wm, replayQueue: rq, registry: reg });

    // Advance the watermark for two sensors first.
    await w.handle(
      envelope({ sensorId: "CAM-RWY10L-01", capturedAt: "2026-05-28T10:00:30.000Z" }),
      { logger },
    );
    await w.handle(
      envelope({ sensorId: "CAM-RWY28R-01", capturedAt: "2026-05-28T10:00:30.000Z" }),
      { logger },
    );
    // First late_beyond_window for sensor A — queue accepts.
    await w.handle(
      envelope({
        sensorId: "CAM-RWY10L-01",
        capturedAt: "2026-05-28T10:00:00.000Z",
        frameId: "first",
      }),
      { logger },
    );
    // Second late_beyond_window for sensor B — queue full; evict + drop.
    await w.handle(
      envelope({
        sensorId: "CAM-RWY28R-01",
        capturedAt: "2026-05-28T10:00:00.000Z",
        frameId: "second",
      }),
      { logger },
    );

    const out = await reg.metrics();
    expect(out).toMatch(/replay_enqueue_total[^\n]*outcome="dropped"[^\n]*\s+1/);
    expect(rq.size()).toBe(1); // capacity respected
  });
});
