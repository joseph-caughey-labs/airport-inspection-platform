import { EventEmitter } from "node:events";
import { createLogger } from "@aip/logger";
import { describe, expect, it, vi } from "vitest";
import {
  RedisSubscriber,
  type ConsumerHandler,
} from "../../../services/event-pipeline/src/consumers/index.js";

const logger = createLogger({ service: "subscriber-test", level: "fatal" });

/**
 * Bare-minimum stub of ioredis: extends EventEmitter so the
 * subscriber can attach to "message" events, and exposes
 * subscribe/unsubscribe as recordable mocks.
 */
function makeFakeRedis() {
  const ee = new EventEmitter();
  const subscribe = vi.fn(async (..._channels: string[]) => undefined);
  const unsubscribe = vi.fn(async (..._channels: string[]) => undefined);
  return {
    redis: Object.assign(ee, {
      subscribe,
      unsubscribe,
    }) as unknown as import("ioredis").default,
    subscribe,
    unsubscribe,
    emitMessage: (channel: string, msg: string) => ee.emit("message", channel, msg),
  };
}

function makeHandler(channel: string, impl?: (r: string) => Promise<void>): ConsumerHandler {
  return {
    name: `h-${channel}`,
    channel,
    handle: impl ?? (async () => undefined),
  };
}

describe("RedisSubscriber", () => {
  it("subscribes to every registered channel on start", async () => {
    const { redis, subscribe } = makeFakeRedis();
    const sub = new RedisSubscriber({ redis, logger });
    sub.setDispatcher(async () => undefined);
    sub.register(makeHandler("sensor.frame.captured"));
    sub.register(makeHandler("ai.detection.emitted"));
    await sub.start();
    expect(subscribe).toHaveBeenCalledWith("sensor.frame.captured", "ai.detection.emitted");
  });

  it("dispatches incoming messages to the handler claiming that channel", async () => {
    const { redis, emitMessage } = makeFakeRedis();
    const sub = new RedisSubscriber({ redis, logger });
    const dispatched: { handler: string; raw: string }[] = [];
    sub.setDispatcher(async (handler, raw) => {
      dispatched.push({ handler: handler.name, raw });
    });
    sub.register(makeHandler("sensor.frame.captured"));
    await sub.start();
    emitMessage("sensor.frame.captured", '{"hello":"world"}');
    await new Promise<void>((r) => setImmediate(r));
    expect(dispatched).toEqual([{ handler: "h-sensor.frame.captured", raw: '{"hello":"world"}' }]);
  });

  it("ignores messages on channels with no registered handler", async () => {
    const { redis, emitMessage } = makeFakeRedis();
    const sub = new RedisSubscriber({ redis, logger });
    const dispatcher = vi.fn(async () => undefined);
    sub.setDispatcher(dispatcher);
    sub.register(makeHandler("sensor.frame.captured"));
    await sub.start();
    emitMessage("ghost.channel", '{"x":1}');
    await new Promise<void>((r) => setImmediate(r));
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("rejects two handlers claiming the same channel with different names", () => {
    const { redis } = makeFakeRedis();
    const sub = new RedisSubscriber({ redis, logger });
    sub.register(makeHandler("sensor.frame.captured"));
    expect(() =>
      sub.register({
        name: "another",
        channel: "sensor.frame.captured",
        handle: async () => undefined,
      }),
    ).toThrow(/already owned/i);
  });

  it("start() requires setDispatcher() first", async () => {
    const { redis } = makeFakeRedis();
    const sub = new RedisSubscriber({ redis, logger });
    sub.register(makeHandler("x.y.z"));
    await expect(sub.start()).rejects.toThrow(/setDispatcher/);
  });

  it("start() is idempotent — second call does not double-subscribe", async () => {
    const { redis, subscribe } = makeFakeRedis();
    const sub = new RedisSubscriber({ redis, logger });
    sub.setDispatcher(async () => undefined);
    sub.register(makeHandler("a.b.c"));
    await sub.start();
    await sub.start();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("stop() unsubscribes from every channel", async () => {
    const { redis, unsubscribe } = makeFakeRedis();
    const sub = new RedisSubscriber({ redis, logger });
    sub.setDispatcher(async () => undefined);
    sub.register(makeHandler("a.b.c"));
    sub.register(makeHandler("d.e.f"));
    await sub.start();
    await sub.stop();
    expect(unsubscribe).toHaveBeenCalledWith("a.b.c", "d.e.f");
  });
});
