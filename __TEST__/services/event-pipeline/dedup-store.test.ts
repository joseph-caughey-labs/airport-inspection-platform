import { describe, expect, it } from "vitest";
import { DedupStore } from "../../../services/event-pipeline/src/dedup/index.js";

describe("DedupStore", () => {
  it("returns false for unseen keys", () => {
    const store = new DedupStore();
    expect(store.has("never")).toBe(false);
  });

  it("returns true for a key within the window after add", () => {
    const store = new DedupStore({ windowMs: 5000 });
    store.add("k1", 1000);
    expect(store.has("k1", 1000 + 4999)).toBe(true);
  });

  it("returns false at exactly the window boundary (expiresAt is exclusive)", () => {
    const store = new DedupStore({ windowMs: 5000 });
    store.add("k1", 1000);
    // Entry expires at 6000 (1000 + 5000). has() returns false when now === expiresAt.
    expect(store.has("k1", 6000)).toBe(false);
  });

  it("returns false past the window", () => {
    const store = new DedupStore({ windowMs: 5000 });
    store.add("k1", 1000);
    expect(store.has("k1", 7000)).toBe(false);
  });

  it("evicts expired entries lazily on has()", () => {
    const store = new DedupStore({ windowMs: 1000 });
    store.add("k1", 0);
    expect(store.size()).toBe(1);
    store.has("k1", 2000); // expired check triggers eviction
    expect(store.size()).toBe(0);
  });

  it("sweep() drops all expired entries and returns the count", () => {
    const store = new DedupStore({ windowMs: 1000, sweepInterval: 1000 });
    store.add("k1", 0);
    store.add("k2", 0);
    store.add("k3", 5000); // still alive at now=5500
    expect(store.sweep(5500)).toBe(2);
    expect(store.size()).toBe(1);
    expect(store.has("k3", 5500)).toBe(true);
  });

  it("triggers automatic sweep every N adds", () => {
    const store = new DedupStore({ windowMs: 1, sweepInterval: 3 });
    store.add("a", 0);
    store.add("b", 0);
    store.add("c", 1000); // 3rd add triggers sweep at now=1000 (a and b are expired by then)
    expect(store.size()).toBe(1);
  });

  it("clear() resets everything", () => {
    const store = new DedupStore();
    store.add("k1");
    store.add("k2");
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.has("k1")).toBe(false);
  });

  it("re-adding a key refreshes its expiry", () => {
    const store = new DedupStore({ windowMs: 1000 });
    store.add("k1", 0);
    store.add("k1", 5000); // refresh
    expect(store.has("k1", 5500)).toBe(true);
  });
});
