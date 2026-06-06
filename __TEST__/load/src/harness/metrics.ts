/**
 * Minimal Prometheus text-exposition scraper + query helpers.
 *
 * The load suite asserts SLOs by reading each service's `/metrics`
 * endpoint (RED triple from `@aip/metrics`, plus the event-pipeline
 * `consumer_*` queue gauges). We parse the text format directly rather
 * than pull in `prom-client` as a parser — the grammar we need is one
 * line per sample.
 */
import { env, type ServiceName } from "./env.js";

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parse the Prometheus text exposition format into flat samples. */
export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const braceStart = trimmed.indexOf("{");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    if (braceStart === -1) {
      const sp = trimmed.indexOf(" ");
      if (sp === -1) continue;
      name = trimmed.slice(0, sp);
      rest = trimmed.slice(sp + 1).trim();
    } else {
      name = trimmed.slice(0, braceStart);
      const braceEnd = trimmed.indexOf("}", braceStart);
      if (braceEnd === -1) continue;
      labels = parseLabels(trimmed.slice(braceStart + 1, braceEnd));
      rest = trimmed.slice(braceEnd + 1).trim();
    }
    const value = Number(rest.split(/\s+/)[0]);
    if (Number.isFinite(value)) samples.push({ name, labels, value });
  }
  return samples;
}

function parseLabels(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  // key="value" pairs; values may contain commas, so match explicitly.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1] as string] = (m[2] as string).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return out;
}

/** Fetch + parse one service's /metrics. Throws if unreachable. */
export async function scrape(service: ServiceName): Promise<Sample[]> {
  const port = env.metricsPorts[service];
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(`http://${env.edge.host}:${port}/metrics`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`/metrics on ${service} returned ${res.status}`);
    return parsePrometheus(await res.text());
  } finally {
    clearTimeout(t);
  }
}

function matches(sample: Sample, labels: Record<string, string>): boolean {
  return Object.entries(labels).every(([k, v]) => sample.labels[k] === v);
}

/** Sum a counter/gauge across all series matching the label subset. */
export function sumWhere(
  samples: Sample[],
  name: string,
  labels: Record<string, string> = {},
): number {
  return samples
    .filter((s) => s.name === name && matches(s, labels))
    .reduce((acc, s) => acc + s.value, 0);
}

/**
 * Estimate a quantile from a histogram's cumulative `_bucket` series
 * (matching the label subset, summed across series), using linear
 * interpolation within the winning bucket. Returns seconds for the RED
 * `*_request_duration_seconds` histogram.
 */
export function histogramQuantile(
  samples: Sample[],
  name: string,
  quantile: number,
  labels: Record<string, string> = {},
): number {
  const buckets = samples
    .filter((s) => s.name === `${name}_bucket` && matches(s, labels))
    .map((s) => ({
      le: s.labels["le"] === "+Inf" ? Infinity : Number(s.labels["le"]),
      count: s.value,
    }));
  if (buckets.length === 0) return NaN;
  // Aggregate identical `le` across label permutations, then sort.
  const byLe = new Map<number, number>();
  for (const b of buckets) byLe.set(b.le, (byLe.get(b.le) ?? 0) + b.count);
  const sorted = [...byLe.entries()].sort((a, b) => a[0] - b[0]);
  const total = sorted[sorted.length - 1]?.[1] ?? 0;
  if (total === 0) return 0;
  const target = quantile * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, cumCount] of sorted) {
    if (cumCount >= target) {
      if (le === Infinity) return prevLe;
      const span = le - prevLe;
      const within = cumCount - prevCount === 0 ? 0 : (target - prevCount) / (cumCount - prevCount);
      return prevLe + span * within;
    }
    prevLe = le;
    prevCount = cumCount;
  }
  return prevLe;
}

/** RED error rate (`*_errors_total` / `*_requests_total`) for a label subset. */
export function errorRate(
  samples: Sample[],
  prefix = "http",
  labels: Record<string, string> = {},
): number {
  const reqs = sumWhere(samples, `${prefix}_requests_total`, labels);
  const errs = sumWhere(samples, `${prefix}_errors_total`, labels);
  return reqs === 0 ? 0 : errs / reqs;
}
