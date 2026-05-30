/**
 * Replay queue worker tests (T-415).
 *
 * The interval-driven worker is exercised via its `tick()` seam so
 * tests stay fast + deterministic. start()/stop() lifecycle is
 * covered with a fake setInterval/clearInterval pair.
 */
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsumerHandler } from "../../../services/event-pipeline/src/consumers/types.js";
import { ReplayQueue } from "../../../services/event-pipeline/src/prioritization/replay-queue.js";
import {
  ReplayQueueWorker,
  _resetReplayMetricsForTests,
} from "../../../services/event-pipeline/src/replay/worker.js";

const logger = createLogger({ service: "replay-worker-test", level: "fatal" });

afterEach(() => {
  _resetReplayMetricsForTests();
});

function reg() {
  return createRegistry({ service: "replay-worker-test", collectDefault: false });
}

function fakeHandler(opts: { fail?: boolean } = {}): ConsumerHandler & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake-persist",
    channel: "sensor.frame.captured",
    calls,
    async handle(raw: string) {
      calls.push(raw);
      if (opts.fail) throw new Error("persist boom");
    },
  };
}

describe("ReplayQueueWorker.tick", () => {
  it("drains every queued item and dispatches each to the handler", async () => {
    const queue = new ReplayQueue();
    queue.enqueue("k1", "p1");
    queue.enqueue("k2", "p2");
    queue.enqueue("k3", "p3");
    const handler = fakeHandler();
    const worker = new ReplayQueueWorker({
      queue,
      handler,
      logger,
      registry: reg(),
    });
    await worker.tick();
    expect(handler.calls).toEqual(["p1", "p2", "p3"]);
    expect(queue.size()).toBe(0);
  });

  it("respects batchSize per tick", async () => {
    const queue = new ReplayQueue();
    queue.enqueue("k1", "p1");
    queue.enqueue("k2", "p2");
    queue.enqueue("k3", "p3");
    const handler = fakeHandler();
    const worker = new ReplayQueueWorker({
      queue,
      handler,
      logger,
      registry: reg(),
      batchSize: 2,
    });
    await worker.tick();
    expect(handler.calls).toEqual(["p1", "p2"]);
    expect(queue.size()).toBe(1);
    await worker.tick();
    expect(handler.calls).toEqual(["p1", "p2", "p3"]);
    expect(queue.size()).toBe(0);
  });

  it("is a no-op on an empty queue", async () => {
    const queue = new ReplayQueue();
    const handler = fakeHandler();
    const worker = new ReplayQueueWorker({
      queue,
      handler,
      logger,
      registry: reg(),
    });
    await worker.tick();
    expect(handler.calls).toEqual([]);
  });

  it("counts processed + errored on the metric counter", async () => {
    const queue = new ReplayQueue();
    queue.enqueue("ok", "good");
    const okHandler = fakeHandler();
    const registry = reg();
    const okWorker = new ReplayQueueWorker({
      queue,
      handler: okHandler,
      logger,
      registry,
    });
    await okWorker.tick();
    const text = await registry.metrics();
    expect(text).toMatch(/replay_drained_total\{[^}]*outcome="processed"[^}]*\}\s+1/);

    // Reset and exercise the errored path on a fresh registry.
    _resetReplayMetricsForTests();
    const queue2 = new ReplayQueue();
    queue2.enqueue("bad", "evil");
    const registry2 = reg();
    const failingWorker = new ReplayQueueWorker({
      queue: queue2,
      handler: fakeHandler({ fail: true }),
      logger,
      registry: registry2,
    });
    await failingWorker.tick();
    const text2 = await registry2.metrics();
    expect(text2).toMatch(/replay_drained_total\{[^}]*outcome="errored"[^}]*\}\s+1/);
  });

  it("does not throw when the handler throws — error is logged and counted", async () => {
    const queue = new ReplayQueue();
    queue.enqueue("k1", "p1");
    queue.enqueue("k2", "p2");
    const worker = new ReplayQueueWorker({
      queue,
      handler: fakeHandler({ fail: true }),
      logger,
      registry: reg(),
    });
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(queue.size()).toBe(0);
  });
});

describe("ReplayQueueWorker.start/stop", () => {
  it("registers an interval at intervalMs and clears it on stop", async () => {
    const queue = new ReplayQueue();
    const handler = fakeHandler();
    let intervalId: { id: number } | undefined;
    let cleared = false;
    const fakeSetInterval = vi.fn((_cb: () => void, ms: number) => {
      intervalId = { id: ms };
      return intervalId as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const fakeClearInterval = vi.fn((id: unknown) => {
      if (id === intervalId) cleared = true;
    }) as unknown as typeof clearInterval;

    const worker = new ReplayQueueWorker({
      queue,
      handler,
      logger,
      registry: reg(),
      intervalMs: 1234,
      setInterval: fakeSetInterval,
      clearInterval: fakeClearInterval,
    });
    worker.start();
    expect(fakeSetInterval).toHaveBeenCalledWith(expect.any(Function), 1234);
    await worker.stop();
    expect(cleared).toBe(true);
  });

  it("start() is idempotent — second call does not register a second interval", async () => {
    const queue = new ReplayQueue();
    const handler = fakeHandler();
    const fakeSetInterval = vi.fn(() => 0 as unknown as ReturnType<typeof setInterval>);
    const worker = new ReplayQueueWorker({
      queue,
      handler,
      logger,
      registry: reg(),
      setInterval: fakeSetInterval as unknown as typeof setInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
    });
    worker.start();
    worker.start();
    expect(fakeSetInterval).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it("stop() waits for the in-flight tick to finish", async () => {
    const queue = new ReplayQueue();
    queue.enqueue("k1", "p1");
    let resolveHandler: () => void = () => {};
    const slowHandler: ConsumerHandler = {
      name: "slow",
      channel: "x",
      handle: () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
    };
    let cb: () => void = () => {};
    const fakeSetInterval = vi.fn((fn: () => void) => {
      cb = fn;
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const worker = new ReplayQueueWorker({
      queue,
      handler: slowHandler,
      logger,
      registry: reg(),
      setInterval: fakeSetInterval,
      clearInterval: vi.fn() as unknown as typeof clearInterval,
    });
    worker.start();
    // Drive a tick manually via the captured callback.
    cb();
    // Stop is now waiting for the handler to resolve.
    const stopPromise = worker.stop();
    // Until we resolve the handler, stop should remain pending.
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveHandler();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
