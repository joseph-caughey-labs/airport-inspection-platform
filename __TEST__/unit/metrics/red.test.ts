import { describe, expect, it } from "vitest";
import { createRedMetrics, createRegistry } from "../../../packages/metrics/src/index.js";

describe("createRedMetrics", () => {
  it("registers request, error, and duration metrics with the given prefix", async () => {
    const registry = createRegistry({ service: "red-test", collectDefault: false });
    const red = createRedMetrics({
      registry,
      prefix: "http",
      labels: ["method", "route", "status"],
    });
    red.request.inc({ method: "GET", route: "/health", status: "200" });
    red.error.inc({ method: "GET", route: "/health", status: "500" });
    red.duration.observe({ method: "GET", route: "/health", status: "200" }, 0.042);

    const output = await registry.metrics();
    expect(output).toContain("http_requests_total");
    expect(output).toContain("http_errors_total");
    expect(output).toContain("http_request_duration_seconds");
  });

  it("attaches the service default label to every metric line", async () => {
    const registry = createRegistry({ service: "default-label-test", collectDefault: false });
    const red = createRedMetrics({ registry, prefix: "rpc", labels: ["method"] });
    red.request.inc({ method: "ping" });
    const output = await registry.metrics();
    expect(output).toContain('service="default-label-test"');
    expect(output).toContain('method="ping"');
  });

  it("honors a custom prefix", async () => {
    const registry = createRegistry({ service: "x", collectDefault: false });
    const red = createRedMetrics({ registry, prefix: "ws", labels: ["channel"] });
    red.request.inc({ channel: "alerts" });
    const output = await registry.metrics();
    expect(output).toContain("ws_requests_total");
    expect(output).not.toContain("http_requests_total");
  });

  it("startTimer returns a function that observes duration on call", async () => {
    const registry = createRegistry({ service: "timer-test", collectDefault: false });
    const red = createRedMetrics({ registry, prefix: "http", labels: ["route"] });
    const stop = red.duration.startTimer({ route: "/x" });
    await new Promise((r) => setTimeout(r, 5));
    stop();
    const output = await registry.metrics();
    expect(output).toContain("http_request_duration_seconds_bucket");
    expect(output).toContain("http_request_duration_seconds_count");
  });
});
