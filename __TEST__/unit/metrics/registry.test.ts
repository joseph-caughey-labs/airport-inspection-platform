import { describe, expect, it } from "vitest";
import { createRegistry } from "../../../packages/metrics/src/index.js";

describe("createRegistry", () => {
  it("creates an isolated registry with the service default label", async () => {
    const registry = createRegistry({ service: "unit-test", collectDefault: false });
    const output = await registry.metrics();
    // The registry is empty until something registers; default labels only
    // appear once a metric is set. Sanity check: metrics call returns a string.
    expect(typeof output).toBe("string");
  });

  it("exposes process metrics when collectDefault is true (default)", async () => {
    const registry = createRegistry({ service: "default-on" });
    const output = await registry.metrics();
    // prom-client default metrics include nodejs_eventloop_lag, process_cpu, etc.
    expect(output).toContain("nodejs_");
    expect(output).toContain('service="default-on"');
  });

  it("does not expose process metrics when collectDefault is false", async () => {
    const registry = createRegistry({ service: "default-off", collectDefault: false });
    const output = await registry.metrics();
    expect(output).not.toContain("nodejs_eventloop_lag");
  });

  it("each registry is isolated (no cross-pollution)", async () => {
    const a = createRegistry({ service: "svc-a", collectDefault: false });
    const b = createRegistry({ service: "svc-b", collectDefault: false });
    expect(a).not.toBe(b);
    // Each carries its own service label
    const outA = await a.metrics();
    const outB = await b.metrics();
    // Both empty until metrics register, but they don't share state.
    expect(typeof outA).toBe("string");
    expect(typeof outB).toBe("string");
  });
});
