import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { describe, expect, it } from "vitest";
import {
  ConsumerOrchestrator,
  type ConsumerHandler,
} from "../../../services/event-pipeline/src/consumers/index.js";

const logger = createLogger({ service: "orchestrator-test", level: "fatal" });

function fakeRegistry() {
  return createRegistry({ service: "test", collectDefault: false });
}

function makeHandler(opts: {
  name?: string;
  channel?: string;
  impl?: (raw: string) => Promise<void>;
}): ConsumerHandler {
  return {
    name: opts.name ?? "test-handler",
    channel: opts.channel ?? "test.channel",
    handle: opts.impl ?? (async () => undefined),
  };
}

describe("ConsumerOrchestrator — outcomes", () => {
  it("returns 'processed' when the handler resolves", async () => {
    const orch = new ConsumerOrchestrator({ registry: fakeRegistry(), logger });
    const outcome = await orch.dispatch(makeHandler({}), "{}");
    expect(outcome).toBe("processed");
  });

  it("returns 'errored' when the handler throws", async () => {
    const orch = new ConsumerOrchestrator({ registry: fakeRegistry(), logger });
    const outcome = await orch.dispatch(
      makeHandler({
        impl: async () => {
          throw new Error("boom");
        },
      }),
      "{}",
    );
    expect(outcome).toBe("errored");
  });

  it("returns 'dropped' when in-flight exceeds maxConcurrency", async () => {
    const orch = new ConsumerOrchestrator({
      registry: fakeRegistry(),
      logger,
      maxConcurrency: 1,
    });
    // Hold one slot busy with a long handler.
    let release: (() => void) | undefined;
    const holdHandler = makeHandler({
      impl: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });

    const busy = orch.dispatch(holdHandler, "{}");
    // Tick the event loop so dispatch enters its critical section.
    await new Promise<void>((r) => setImmediate(r));

    // Second dispatch should drop.
    const outcome = await orch.dispatch(holdHandler, "{}");
    expect(outcome).toBe("dropped");

    release?.();
    expect(await busy).toBe("processed");
  });
});

describe("ConsumerOrchestrator — metrics", () => {
  it("emits processed counter on success", async () => {
    const registry = fakeRegistry();
    const orch = new ConsumerOrchestrator({ registry, logger });
    await orch.dispatch(makeHandler({ name: "h-success" }), "{}");
    const out = await registry.metrics();
    expect(out).toMatch(/consumer_processed_total[^\n]*queue="h-success"/);
    expect(out).toMatch(/consumer_processed_total\{[^}]+\}\s+1/);
  });

  it("emits errors counter on handler throw", async () => {
    const registry = fakeRegistry();
    const orch = new ConsumerOrchestrator({ registry, logger });
    await orch.dispatch(
      makeHandler({
        name: "h-error",
        impl: async () => {
          throw new Error("boom");
        },
      }),
      "{}",
    );
    const out = await registry.metrics();
    expect(out).toMatch(/consumer_errors_total[^\n]*queue="h-error"/);
  });

  it("emits dropped counter on backpressure", async () => {
    const registry = fakeRegistry();
    const orch = new ConsumerOrchestrator({
      registry,
      logger,
      maxConcurrency: 1,
    });
    let release: (() => void) | undefined;
    const hold = makeHandler({
      name: "h-drop",
      impl: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const busy = orch.dispatch(hold, "{}");
    await new Promise<void>((r) => setImmediate(r));
    await orch.dispatch(hold, "{}"); // dropped
    release?.();
    await busy;
    const out = await registry.metrics();
    expect(out).toMatch(/consumer_dropped_total[^\n]*queue="h-drop"/);
  });

  it("each handler gets its own metric slice", async () => {
    const registry = fakeRegistry();
    const orch = new ConsumerOrchestrator({ registry, logger });
    await orch.dispatch(makeHandler({ name: "h-a" }), "{}");
    await orch.dispatch(makeHandler({ name: "h-b" }), "{}");
    const out = await registry.metrics();
    expect(out).toMatch(/queue="h-a"/);
    expect(out).toMatch(/queue="h-b"/);
  });
});
