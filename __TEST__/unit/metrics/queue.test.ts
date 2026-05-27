import { describe, expect, it } from "vitest";
import { createQueueMetrics, createRegistry } from "../../../packages/metrics/src/index.js";

describe("createQueueMetrics", () => {
  it("exposes depth, processed, errors, dropped under the queue prefix", async () => {
    const registry = createRegistry({ service: "queue-test", collectDefault: false });
    const queue = createQueueMetrics({
      registry,
      name: "events.broadcast",
      prefix: "queue",
    });
    queue.depth.set(42);
    queue.processed.inc(3);
    queue.errors.inc();
    queue.dropped.inc(2);

    const output = await registry.metrics();
    expect(output).toContain("queue_depth");
    expect(output).toContain("queue_processed_total");
    expect(output).toContain("queue_errors_total");
    expect(output).toContain("queue_dropped_total");
    expect(output).toContain('queue="events.broadcast"');
  });

  it("attaches the service label by default", async () => {
    const registry = createRegistry({ service: "ops", collectDefault: false });
    const queue = createQueueMetrics({ registry, name: "sensor.frames" });
    queue.processed.inc();
    const output = await registry.metrics();
    expect(output).toContain('service="ops"');
    expect(output).toContain('queue="sensor.frames"');
  });

  it("uses a custom prefix when provided", async () => {
    const registry = createRegistry({ service: "x", collectDefault: false });
    const queue = createQueueMetrics({
      registry,
      name: "ai.detections",
      prefix: "stream",
    });
    queue.processed.inc();
    const output = await registry.metrics();
    expect(output).toContain("stream_processed_total");
    expect(output).not.toContain("queue_processed_total");
  });
});
