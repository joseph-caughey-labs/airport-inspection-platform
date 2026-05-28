import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../../../services/ws-broadcaster/src/channels/registry.js";
import { RedisBridge } from "../../../services/ws-broadcaster/src/redis-bridge.js";
import type { BroadcastClient } from "../../../services/ws-broadcaster/src/channels/types.js";

const logger = createLogger({ service: "bridge-test", level: "fatal" });
function reg() {
  return createRegistry({ service: "bridge-test", collectDefault: false });
}

const AIRPORT_A = "11111111-2222-3333-4444-555555555555";
const AIRPORT_B = "99999999-9999-9999-9999-999999999999";

function makeClient(): { client: BroadcastClient; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return {
    client: { role: "viewer", send, close: vi.fn() },
    send,
  };
}

function fakeRedis() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => 1),
    punsubscribe: vi.fn(async () => 1),
  } as unknown as import("ioredis").default;
}

const validEnvelope = JSON.stringify({
  event_id: "11111111-2222-3333-4444-555555555555",
  event_type: "sensor.frame.captured",
  schema_version: "v1",
  source: { service: "event-pipeline" },
  timestamp: "2026-05-28T10:00:00.000Z",
  payload: { sensor_id: "CAM-1", sensor_type: "camera" },
});

describe("RedisBridge.handleMessage", () => {
  it("dispatches to registry by airport extracted from channel", () => {
    const registry = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    registry.subscribe(AIRPORT_A, a.client);
    const b = new RedisBridge({
      redis: fakeRedis(),
      logger,
      registry: reg(),
      channelRegistry: registry,
    });
    b.handleMessage(`events.broadcast.${AIRPORT_A}`, validEnvelope);
    expect(a.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(a.send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("sensor.frame.captured");
    expect(sent.last_event_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(sent.payload.sensor_id).toBe("CAM-1");
  });

  it("only dispatches to the airport in the channel name", () => {
    const registry = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    const b = makeClient();
    registry.subscribe(AIRPORT_A, a.client);
    registry.subscribe(AIRPORT_B, b.client);
    const bridge = new RedisBridge({
      redis: fakeRedis(),
      logger,
      registry: reg(),
      channelRegistry: registry,
    });
    bridge.handleMessage(`events.broadcast.${AIRPORT_A}`, validEnvelope);
    expect(a.send).toHaveBeenCalled();
    expect(b.send).not.toHaveBeenCalled();
  });

  it("drops messages with no airport segment and counts invalid", async () => {
    const registry = new ChannelRegistry({ registry: reg() });
    const promReg = reg();
    const bridge = new RedisBridge({
      redis: fakeRedis(),
      logger,
      registry: promReg,
      channelRegistry: registry,
    });
    bridge.handleMessage("events.broadcast", validEnvelope);
    bridge.handleMessage("wrong.prefix.abc", validEnvelope);
    const text = await promReg.metrics();
    expect(text).toMatch(/ws_broadcaster_invalid_total[^\n]*reason="missing_airport"[^\n]*2/);
  });

  it("drops messages with malformed JSON payload", async () => {
    const registry = new ChannelRegistry({ registry: reg() });
    const promReg = reg();
    const bridge = new RedisBridge({
      redis: fakeRedis(),
      logger,
      registry: promReg,
      channelRegistry: registry,
    });
    bridge.handleMessage(`events.broadcast.${AIRPORT_A}`, "{not json");
    const text = await promReg.metrics();
    expect(text).toMatch(/ws_broadcaster_invalid_total[^\n]*reason="malformed_payload"/);
  });

  it("increments received counter per airport", async () => {
    const registry = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    registry.subscribe(AIRPORT_A, a.client);
    const promReg = reg();
    const bridge = new RedisBridge({
      redis: fakeRedis(),
      logger,
      registry: promReg,
      channelRegistry: registry,
    });
    bridge.handleMessage(`events.broadcast.${AIRPORT_A}`, validEnvelope);
    const text = await promReg.metrics();
    expect(text).toMatch(/ws_broadcaster_received_total[^\n]*airport="11111111/);
  });
});

describe("RedisBridge.start/stop", () => {
  it("psubscribes to the configured pattern on start, punsubscribes on stop", async () => {
    const fake = fakeRedis();
    const bridge = new RedisBridge({
      redis: fake,
      logger,
      registry: reg(),
      channelRegistry: new ChannelRegistry({ registry: reg() }),
      pattern: "events.broadcast.*",
    });
    await bridge.start();
    expect(fake.psubscribe).toHaveBeenCalledWith("events.broadcast.*");
    expect(fake.on).toHaveBeenCalledWith("pmessage", expect.any(Function));
    await bridge.stop();
    expect(fake.punsubscribe).toHaveBeenCalledWith("events.broadcast.*");
    expect(fake.off).toHaveBeenCalledWith("pmessage", expect.any(Function));
  });

  it("start is idempotent", async () => {
    const fake = fakeRedis();
    const bridge = new RedisBridge({
      redis: fake,
      logger,
      registry: reg(),
      channelRegistry: new ChannelRegistry({ registry: reg() }),
    });
    await bridge.start();
    await bridge.start();
    expect(fake.psubscribe).toHaveBeenCalledTimes(1);
  });
});
