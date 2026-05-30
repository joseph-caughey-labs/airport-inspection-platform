# Metrics conventions

What every TS service in this monorepo exposes on `/metrics`, why those names + labels were chosen, and what a Prometheus scraper sees on a fresh deploy.

## The RED triple

Every Fastify service exposes the canonical RED (Request rate, Error rate, Duration) triple plus a `/metrics` endpoint, wired in a single line at app build time:

```ts
import { installMetrics } from "@aip/metrics";

const app = Fastify({ logger: { level: logger.level } });
app.addHook("onRequest", correlationHook());
installMetrics({ app, registry });
```

`installMetrics` does three things:

1. Registers an `onRequest` hook that stamps a high-resolution start timestamp on the request.
2. Registers an `onResponse` hook that:
   - increments `http_requests_total` per `{method, route, status}`
   - increments `http_errors_total` when `reply.statusCode >= 400`
   - observes `http_request_duration_seconds` from the request start
3. Registers `GET /metrics` that returns the registry's prom-format exposition with the right `content-type`.

The three resulting metrics:

| Metric                          | Type      | Labels                  |
| ------------------------------- | --------- | ----------------------- |
| `http_requests_total`           | Counter   | `method, route, status` |
| `http_errors_total`             | Counter   | `method, route, status` |
| `http_request_duration_seconds` | Histogram | `method, route, status` |

Plus the standard Node process metrics (`process_cpu_seconds_total`, `process_resident_memory_bytes`, …) registered automatically by `createRegistry({ service })` via `prom-client`'s `collectDefaultMetrics`.

## Why these labels and not others

- **`route` is the route PATTERN, not the URL.** Fastify exposes `req.routeOptions.url` — `/incidents/:id`, not `/incidents/0e3a-…-fd91`. Using the actual URL would explode the cardinality of the `route` label (every incident id = a new series, hundreds of new series per day in a real airport). The pattern keeps cardinality bounded by the number of routes, which is small.
- **`status` is the status CLASS, not the exact code.** `2xx` / `4xx` / `5xx` captures the only operational distinction the on-call cares about. The exact code is in the log line for any specific response (the `correlation_id` joins the metric series to the log row).
- **`method` is lowercased.** Folding `GET` and `get` into a single series keeps the count down without losing information.
- **No `request_id` / `user_id` / `airport_id` labels.** Those are unbounded — they belong in logs and traces, not in metric labels. Putting them here would blow up Prometheus storage and slow down PromQL queries.

## What's excluded from RED

`installMetrics` excludes three routes from RED counters by default:

- `/metrics` — the scrape endpoint itself; counting scrapes drowns out user traffic in the metric.
- `/health` — liveness probe, called on a tight loop by the orchestrator.
- `/ready` — readiness probe, same.

A caller can override the exclusion list via `installMetrics({ app, registry, ignoreRoutes })`.

## Per-service domain metrics

The RED triple is the shared contract. Each service also exposes its own domain-specific metrics, registered against the same registry — they show up alongside the RED ones on the same `/metrics` scrape:

| Service             | Examples                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `incident-service`  | `incident_events_published_total`, `incident_events_publish_failures_total`                   |
| `validation-engine` | `validation_layers_run_total`, `validation_runs_total`, `validation_run_duration_seconds`     |
| `event-pipeline`    | `frame_priority`, `frame_order_total`, `replay_drained_total`, outbox + ai-detection counters |

Conventions for new domain metrics:

- **Counter names end in `_total`.** prom-client warns otherwise; the SRE dashboard convention assumes it.
- **Histogram name is `<unit_optional>_<verb>_<unit>` with `_seconds` for durations.** Examples: `validation_run_duration_seconds`, `frame_priority` (no unit because it's a unitless score).
- **Labels are low-cardinality and stable.** A new label is a metrics-API breaking change; assume dashboards key off the existing label set.

## `/metrics` endpoint

A fresh `GET /metrics` against `api-gateway` returns:

```
# HELP http_requests_total Total http requests received
# TYPE http_requests_total counter

# HELP http_errors_total Total http responses that resulted in error
# TYPE http_errors_total counter

# HELP http_request_duration_seconds http request duration in seconds
# TYPE http_request_duration_seconds histogram

# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.
# TYPE process_cpu_user_seconds_total counter
process_cpu_user_seconds_total{service="api-gateway"} 0.0245
…
```

Every line carries the `service` default label set in `createRegistry({ service })`, so a single Prometheus instance scraping the cluster can disambiguate metrics that share names across services (e.g. `http_requests_total` from `incident-service` vs from `audit-service`).

## Test seam

`createRegistry({ collectDefault: false })` disables the Node process metrics for unit tests. This keeps output deterministic — process CPU time is non-zero and varies per run. Production callers omit the flag so the platform metrics ship.

A test that asserts on metric content typically:

1. Drives a request via Fastify's `inject`.
2. Reads `/metrics` (also via `inject`).
3. Splits the body on `\n` and finds the line matching the metric name + a substring of the expected label set. Asserting a substring keeps the test robust against prom-client label-order differences.

See `__TEST__/services/api-gateway/app.test.ts` for the canonical pattern.

## Production evolution

The current setup writes to an in-process registry that a Prometheus server scrapes via HTTP. A real production deployment would:

- Run a Prometheus server in the cluster scraping every service's `/metrics` at a 10-second cadence; remote-write to a long-term store (Cortex / Mimir / Thanos / managed).
- Add a Grafana dashboard per service template, plus a per-incident dashboard keyed on `correlation_id` that joins the RED triple with the audit trail.
- Add **service-level objectives (SLOs)**: e.g. `incident-service` 99% of `POST /incidents/:id/acknowledge` < 250ms (a 5xx burns the error budget; a slow 200 doesn't).
- Promote `correlation_id` into a distributed trace id and add OpenTelemetry-format exemplars to the histogram so a slow request's span links directly out of a Prometheus query result.
- Tune histogram bucket boundaries per-service from observed traffic — defaults (`5ms … 10s`) suit most HTTP surfaces; the validation engine's run histogram has tighter buckets at the bottom because it's expected to be sub-100ms.

The interfaces in `@aip/metrics` don't change for any of those — the RED hook keeps emitting, the registry keeps collecting, and the scrape endpoint keeps serving.
