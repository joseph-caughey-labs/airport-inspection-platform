import { describe, expect, it } from "vitest";
import { ReplayQueue } from "../../../services/event-pipeline/src/prioritization/index.js";

describe("ReplayQueue", () => {
  it("enqueue accepts up to maxSize items", () => {
    const q = new ReplayQueue({ maxSize: 3 });
    expect(q.enqueue("a", "1")).toBe(true);
    expect(q.enqueue("b", "2")).toBe(true);
    expect(q.enqueue("c", "3")).toBe(true);
    expect(q.size()).toBe(3);
  });

  it("over-capacity enqueue evicts oldest and returns false", () => {
    const q = new ReplayQueue({ maxSize: 2 });
    q.enqueue("a", "1");
    q.enqueue("b", "2");
    const accepted = q.enqueue("c", "3");
    expect(accepted).toBe(false);
    expect(q.size()).toBe(2);
    expect(q.peek().map((i) => i.key)).toEqual(["b", "c"]);
  });

  it("drain() returns items in FIFO order and removes them", () => {
    const q = new ReplayQueue();
    q.enqueue("a", "1");
    q.enqueue("b", "2");
    q.enqueue("c", "3");
    const taken = q.drain();
    expect(taken.map((i) => i.key)).toEqual(["a", "b", "c"]);
    expect(q.size()).toBe(0);
  });

  it("drain(limit) takes up to limit items and leaves the rest", () => {
    const q = new ReplayQueue();
    q.enqueue("a", "1");
    q.enqueue("b", "2");
    q.enqueue("c", "3");
    const taken = q.drain(2);
    expect(taken.map((i) => i.key)).toEqual(["a", "b"]);
    expect(q.size()).toBe(1);
    expect(q.peek()[0]?.key).toBe("c");
  });

  it("each item carries an enqueuedAt timestamp", () => {
    const q = new ReplayQueue();
    q.enqueue("a", "1", 1234);
    expect(q.peek()[0]?.enqueuedAt).toBe(1234);
  });
});
