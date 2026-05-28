import { createLogger } from "@aip/logger";
import { SensorFrameEvent } from "@aip/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraSimulator } from "../../../services/sensor-gateway/src/simulators/camera.js";

const logger = createLogger({ service: "camera-test", level: "fatal" });

function makeRedis(impl?: (channel: string, payload: string) => Promise<number>) {
  const publish = vi.fn(
    impl ?? (async (_c: string, _p: string) => 1),
  ) as unknown as import("ioredis").default["publish"];
  return {
    publish,
  } as unknown as import("ioredis").default;
}

function makeContext(redis: import("ioredis").default, channel = "sensor.frame.captured") {
  return {
    redis,
    logger,
    channel,
    now: () => Date.parse("2026-05-28T10:00:00.000Z"),
  };
}

const baseConfig = {
  sensorId: "CAM-RWY10L-01",
  sensorType: "camera" as const,
  airportId: "11111111-1111-1111-1111-aaaaaaaaaaaa",
  location: { lat: 37.6213, lng: -122.379, alt_m: 4 },
  hz: 5,
};

describe("CameraSimulator — tick()", () => {
  it("publishes a well-formed SensorFrameEvent to the configured channel", async () => {
    const redis = makeRedis();
    const sim = new CameraSimulator(baseConfig, makeContext(redis));
    await sim.tick();

    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(channel).toBe("sensor.frame.captured");

    const event = SensorFrameEvent.parse(JSON.parse(payload as string));
    expect(event.payload.sensor_id).toBe("CAM-RWY10L-01");
    expect(event.payload.sensor_type).toBe("camera");
    expect(event.event_type).toBe("sensor.frame.captured");
    expect(event.payload.geo).toEqual({ lat: 37.6213, lng: -122.379, alt_m: 4 });
  });

  it("monotonically increments frame_id across ticks", async () => {
    const redis = makeRedis();
    const sim = new CameraSimulator(baseConfig, makeContext(redis));
    await sim.tick();
    await sim.tick();
    await sim.tick();

    const calls = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const frameIds = calls.map(
      (c) => SensorFrameEvent.parse(JSON.parse(c[1] as string)).payload.frame_id,
    );
    expect(frameIds).toEqual([
      "CAM-RWY10L-01-00000001",
      "CAM-RWY10L-01-00000002",
      "CAM-RWY10L-01-00000003",
    ]);
  });

  it("emits the configured frame dimensions in metadata", async () => {
    const redis = makeRedis();
    const sim = new CameraSimulator(
      { ...baseConfig, width: 1280, height: 720, fixtureRef: "tarmac-empty" },
      makeContext(redis),
    );
    await sim.tick();
    const payload = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const event = SensorFrameEvent.parse(JSON.parse(payload as string));
    expect(event.payload.metadata).toMatchObject({
      width: 1280,
      height: 720,
      fixture_ref: "tarmac-empty",
    });
  });

  it("defaults to 1920×1080 when no dimensions configured", async () => {
    const redis = makeRedis();
    const sim = new CameraSimulator(baseConfig, makeContext(redis));
    await sim.tick();
    const payload = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const event = SensorFrameEvent.parse(JSON.parse(payload as string));
    expect(event.payload.metadata).toMatchObject({ width: 1920, height: 1080 });
  });

  it("attaches an idempotency_key derived from sensor + frame counter", async () => {
    const redis = makeRedis();
    const sim = new CameraSimulator(baseConfig, makeContext(redis));
    await sim.tick();
    const payload = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const event = SensorFrameEvent.parse(JSON.parse(payload as string));
    expect(event.idempotency_key).toBe("frame:CAM-RWY10L-01-00000001");
  });

  it("drops the frame (no throw) when publish fails", async () => {
    const failing = makeRedis(async () => {
      throw new Error("connection refused");
    });
    const sim = new CameraSimulator(baseConfig, makeContext(failing));
    // Should not throw — backpressure-safe per the brief.
    await expect(sim.tick()).resolves.toBeUndefined();
  });
});

describe("CameraSimulator — start/stop lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits ~hz frames per second when started", async () => {
    const redis = makeRedis();
    const sim = new CameraSimulator(
      { ...baseConfig, hz: 10 }, // 100ms interval
      makeContext(redis),
    );
    sim.start();
    // Advance 500ms — expect ~5 frames.
    await vi.advanceTimersByTimeAsync(500);
    await sim.stop();
    const calls = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(calls).toBeLessThanOrEqual(6);
  });

  it("stop() halts the tick loop", async () => {
    const redis = makeRedis();
    const sim = new CameraSimulator({ ...baseConfig, hz: 10 }, makeContext(redis));
    sim.start();
    await vi.advanceTimersByTimeAsync(150);
    await sim.stop();
    const beforeStop = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    const afterStop = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterStop).toBe(beforeStop);
  });

  it("start() is idempotent (second call does not double the rate)", async () => {
    const redis = makeRedis();
    const sim = new CameraSimulator({ ...baseConfig, hz: 10 }, makeContext(redis));
    sim.start();
    sim.start();
    sim.start();
    await vi.advanceTimersByTimeAsync(300);
    await sim.stop();
    const calls = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    // ~3 frames at 10 Hz in 300ms, not 9.
    expect(calls).toBeLessThanOrEqual(4);
  });
});
