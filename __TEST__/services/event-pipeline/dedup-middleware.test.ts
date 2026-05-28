import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConsumerHandler } from "../../../services/event-pipeline/src/consumers/index.js";
import {
  DedupStore,
  _resetSuppressedCounterForTests,
  extractIdempotencyKey,
  withIdempotencyDedup,
} from "../../../services/event-pipeline/src/dedup/index.js";

const logger = createLogger({ service: "dedup-test", level: "fatal" });

afterEach(() => {
  _resetSuppressedCounterForTests();
});

function makeRegistry() {
  return createRegistry({ service: "dedup-test", collectDefault: false });
}

function makeInner(): ConsumerHandler & { calls: number } {
  let calls = 0;
  return {
    name: "inner-handler",
    channel: "test.channel",
    async handle() {
      calls++;
    },
    get calls() {
      return calls;
    },
  } as ConsumerHandler & { calls: number };
}

describe("extractIdempotencyKey", () => {
  it("returns the key when present and non-empty", () => {
    expect(extractIdempotencyKey('{"idempotency_key":"frame:abc"}')).toBe("frame:abc");
  });

  it("returns null when the field is missing", () => {
    expect(extractIdempotencyKey('{"event_id":"x"}')).toBeNull();
  });

  it("returns null when the value is an empty string", () => {
    expect(extractIdempotencyKey('{"idempotency_key":""}')).toBeNull();
  });

  it("returns null when the value is not a string", () => {
    expect(extractIdempotencyKey('{"idempotency_key":42}')).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractIdempotencyKey("{not json")).toBeNull();
  });
});

describe("withIdempotencyDedup", () => {
  it("passes through the first message with a given key", async () => {
    const inner = makeInner();
    const store = new DedupStore({ windowMs: 5000 });
    const wrapped = withIdempotencyDedup(inner, { store, registry: makeRegistry() });
    await wrapped.handle('{"idempotency_key":"frame:1"}', { logger });
    expect(inner.calls).toBe(1);
  });

  it("suppresses a second message with the same key in the window", async () => {
    const inner = makeInner();
    const store = new DedupStore({ windowMs: 5000 });
    const wrapped = withIdempotencyDedup(inner, { store, registry: makeRegistry() });
    await wrapped.handle('{"idempotency_key":"frame:1"}', { logger });
    await wrapped.handle('{"idempotency_key":"frame:1"}', { logger });
    expect(inner.calls).toBe(1);
  });

  it("emits consumer_suppressed_total on suppression", async () => {
    const inner = makeInner();
    const store = new DedupStore({ windowMs: 5000 });
    const registry = makeRegistry();
    const wrapped = withIdempotencyDedup(inner, { store, registry });
    await wrapped.handle('{"idempotency_key":"frame:1"}', { logger });
    await wrapped.handle('{"idempotency_key":"frame:1"}', { logger });
    const out = await registry.metrics();
    expect(out).toMatch(/consumer_suppressed_total[^\n]*queue="inner-handler"/);
  });

  it("passes through messages without idempotency_key (dedup is opt-in)", async () => {
    const inner = makeInner();
    const store = new DedupStore();
    const wrapped = withIdempotencyDedup(inner, { store, registry: makeRegistry() });
    await wrapped.handle('{"foo":1}', { logger });
    await wrapped.handle('{"foo":1}', { logger });
    expect(inner.calls).toBe(2);
  });

  it("propagates inner-handler errors", async () => {
    const failing: ConsumerHandler = {
      name: "failing",
      channel: "test.channel",
      handle: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const wrapped = withIdempotencyDedup(failing, {
      store: new DedupStore(),
      registry: makeRegistry(),
    });
    await expect(wrapped.handle('{"idempotency_key":"k1"}', { logger })).rejects.toThrow(/boom/);
  });

  it("different keys do not suppress each other", async () => {
    const inner = makeInner();
    const store = new DedupStore({ windowMs: 5000 });
    const wrapped = withIdempotencyDedup(inner, { store, registry: makeRegistry() });
    await wrapped.handle('{"idempotency_key":"frame:1"}', { logger });
    await wrapped.handle('{"idempotency_key":"frame:2"}', { logger });
    await wrapped.handle('{"idempotency_key":"frame:3"}', { logger });
    expect(inner.calls).toBe(3);
  });
});
