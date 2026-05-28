# `@aip/metrics`

Prometheus metrics for every Node/TS service in the platform. Built on [prom-client](https://github.com/siimon/prom-client), with three opinionated factories on top:

1. **`createRegistry({ service })`** — per-service `Registry` with `service` as a default label. Default Node process metrics auto-registered.
2. **`createRedMetrics(...)`** — Rate / Errors / Duration counters + histogram for any HTTP/RPC-like surface.
3. **`createQueueMetrics(...)`** — depth / processed / errors / dropped for any consumer (Redis subscriber, worker pool).

## Usage

```ts
import { createRegistry, createRedMetrics, createQueueMetrics } from "@aip/metrics";

// One registry per service, at startup.
const registry = createRegistry({ service: "sensor-gateway" });

// HTTP / RPC surface
const http = createRedMetrics({
  registry,
  prefix: "http",
  labels: ["method", "route", "status"],
});

// In a route handler:
const stopTimer = http.duration.startTimer({ method: "GET", route: "/health" });
// ... handle ...
http.request.inc({ method: "GET", route: "/health", status: "200" });
stopTimer({ status: "200" });

// Redis consumer or worker queue
const queue = createQueueMetrics({ registry, name: "events.broadcast" });
queue.depth.set(currentLag);
queue.processed.inc();
queue.errors.inc(); // on failure
queue.dropped.inc(); // when backpressure sheds load
```

Expose `/metrics` from each service:

```ts
fastify.get("/metrics", async (_req, reply) => {
  reply.type(registry.contentType);
  return await registry.metrics();
});
```

## Conventions

- **One registry per service**, named `aip_<service>_*` via factories' `prefix` option (defaults set sensibly).
- **Service label** auto-attached as a default label on every metric.
- **Bucket presets** for `duration`: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds.
- **High-cardinality labels are forbidden** — never put user ids, request ids, or sensor ids in labels. Use logs for those.

## Why opinionated factories

prom-client gives you raw `Counter`, `Histogram`, `Gauge`. Every service ends up reinventing the same RED / queue patterns. These factories give you the right shape on the first try, with consistent naming across services.
