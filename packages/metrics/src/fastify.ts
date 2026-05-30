/**
 * Fastify integration for `@aip/metrics`.
 *
 * - `redHook({ red })` — an `onResponse` Fastify hook that auto-
 *   records the canonical RED triple (request counter, error
 *   counter, duration histogram) per request, labeled by
 *   `method`, `route`, and `status` class (`2xx`, `4xx`, `5xx`).
 * - `metricsRoute(app, registry)` — registers `GET /metrics` with
 *   the right `content-type` so a Prometheus scraper finds it.
 * - `installMetrics({ app, registry, prefix?, ignoreRoutes? })` —
 *   the one-liner that does both. Every Fastify service in the
 *   monorepo wires it the same way at app build time.
 *
 * Why label by route + method + status_class instead of by status
 * code, path, or the full URL:
 *
 *   - **Route pattern, not URL.** Fastify exposes `req.routeOptions.url`
 *     (e.g. `/incidents/:id`) — the pattern with placeholders. Using
 *     the actual `req.url` would explode the cardinality of the
 *     `route` label (every incident id = a new series).
 *   - **Status class, not exact code.** `2xx` / `4xx` / `5xx`
 *     captures the only operational distinction the on-call cares
 *     about. The exact code is in the log line for any specific
 *     response.
 *   - **Method, lowercased.** `GET` vs `POST` is the operational
 *     contrast; case normalization keeps the series count down.
 *
 * `ignoreRoutes` lets the caller exclude `/metrics` itself (and
 * `/health` / `/ready` if they want) — otherwise scrape traffic
 * dominates the RED counters.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createRedMetrics, type RedMetrics } from "./red.js";
import type { Registry } from "./registry.js";

export interface RedHookOptions {
  red: RedMetrics;
  /**
   * Route patterns that should NOT increment the RED counters.
   * Default: nothing — the caller usually wants `/metrics`,
   * `/health`, `/ready` here.
   */
  ignoreRoutes?: readonly string[];
}

/**
 * Build the Fastify `onResponse` hook. Pair with `addHook`:
 *
 *   const red = createRedMetrics({ registry, labels: METRIC_LABELS });
 *   app.addHook("onResponse", redHook({ red, ignoreRoutes }));
 */
export function redHook(
  opts: RedHookOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const ignore = new Set(opts.ignoreRoutes ?? []);
  return async (req, reply) => {
    const route = routeOf(req);
    if (ignore.has(route)) return;

    const labels = {
      method: req.method.toLowerCase(),
      route,
      status: statusClassOf(reply.statusCode),
    };

    opts.red.request.inc(labels);
    if (reply.statusCode >= 400) {
      opts.red.error.inc(labels);
    }
    // Fastify's reply has its own elapsed-time tracker, but it isn't
    // part of the typed API. Read response time off the underlying
    // `getResponseTime()` when available — falls back to the
    // request-start timestamp set by `redHook` (see `installMetrics`).
    const elapsedSeconds = elapsedSecondsOf(reply, req);
    if (elapsedSeconds !== undefined) {
      opts.red.duration.observe(labels, elapsedSeconds);
    }
  };
}

/**
 * Register `GET /metrics` so a Prometheus scraper can read the
 * registry. Sets `content-type` to whatever `Registry.contentType`
 * declares (text vs OpenMetrics protobuf).
 */
export function metricsRoute(app: FastifyInstance, registry: Registry): void {
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}

export interface InstallMetricsOptions {
  app: FastifyInstance;
  registry: Registry;
  /** Metric name prefix; default `http`. */
  prefix?: string;
  /** Routes excluded from RED — typically `/metrics`, `/health`, `/ready`. */
  ignoreRoutes?: readonly string[];
}

/** Canonical RED labels every service uses. Keep low-cardinality. */
export const RED_LABELS = ["method", "route", "status"] as const;

/**
 * One-liner that does both ends: build the RED metrics, attach the
 * `onResponse` hook, and register `/metrics`. Default `ignoreRoutes`
 * excludes the three health/scrape paths so scrape traffic doesn't
 * dominate the counters.
 */
export function installMetrics(opts: InstallMetricsOptions): RedMetrics {
  const red = createRedMetrics({
    registry: opts.registry,
    prefix: opts.prefix ?? "http",
    labels: [...RED_LABELS],
  });
  opts.app.addHook("onRequest", async (req) => {
    // Stash the start timestamp so the response hook can compute
    // duration even if fastify's internal timer isn't available.
    (req as unknown as { _aip_start_hrtime: bigint })._aip_start_hrtime = process.hrtime.bigint();
  });
  opts.app.addHook(
    "onResponse",
    redHook({
      red,
      ignoreRoutes: opts.ignoreRoutes ?? ["/metrics", "/health", "/ready"],
    }),
  );
  metricsRoute(opts.app, opts.registry);
  return red;
}

function routeOf(req: FastifyRequest): string {
  // `req.routeOptions.url` is the pattern (e.g. `/incidents/:id`).
  // Falls back to `req.url` when the route wasn't matched — which is
  // only the case on 404, and our notFoundHandler should label
  // those `<unmatched>` rather than echoing the raw URL into the
  // cardinality.
  const options = (req as unknown as { routeOptions?: { url?: string } }).routeOptions;
  return options?.url ?? "<unmatched>";
}

function statusClassOf(code: number): string {
  if (code >= 500) return "5xx";
  if (code >= 400) return "4xx";
  if (code >= 300) return "3xx";
  if (code >= 200) return "2xx";
  return `${code}`;
}

function elapsedSecondsOf(reply: FastifyReply, req: FastifyRequest): number | undefined {
  // Fastify 5 exposes `reply.elapsedTime` (ms) on every reply.
  const elapsedMs = (reply as unknown as { elapsedTime?: number }).elapsedTime;
  if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs)) {
    return elapsedMs / 1000;
  }
  const start = (req as unknown as { _aip_start_hrtime?: bigint })._aip_start_hrtime;
  if (typeof start === "bigint") {
    const elapsedNs = process.hrtime.bigint() - start;
    return Number(elapsedNs) / 1e9;
  }
  return undefined;
}
