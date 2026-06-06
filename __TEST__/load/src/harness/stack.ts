/**
 * Stack reachability probe + skip-guard.
 *
 * The load scenarios are useless (and would hang) without the live
 * compose stack. Rather than fail a clean checkout or an accidental
 * `pnpm test:load`, every scenario opens with `await describeIfStackUp`
 * — if Redis and the nginx edge aren't both reachable, the whole file
 * is skipped with a one-line reason. This keeps "runnable" honest: the
 * suite runs when the stack is up and no-ops cleanly when it isn't.
 */
import Redis from "ioredis";
import { env } from "./env.js";

let cached: { up: boolean; reason: string } | undefined;

async function redisReachable(): Promise<boolean> {
  const redis = new Redis({
    host: env.redis.host,
    port: env.redis.port,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1500,
    retryStrategy: () => null, // one shot, no reconnect loop
    lazyConnect: true,
  });
  // Swallow socket 'error' events — when the stack is down a connect
  // failure is the expected answer, not an unhandled-rejection noise.
  redis.on("error", () => {});
  try {
    await redis.connect();
    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

async function edgeReachable(): Promise<boolean> {
  const url = `http://${env.edge.host}:${env.edge.port}/health`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    // Any HTTP answer (even 404) proves the edge is listening; we only
    // need "something is on the port", not a specific status.
    return res.status > 0;
  } catch {
    return false;
  }
}

/** Probe Redis + the nginx edge once; cache the verdict for the run. */
export async function probeStack(): Promise<{ up: boolean; reason: string }> {
  if (cached) return cached;
  const [redis, edge] = await Promise.all([redisReachable(), edgeReachable()]);
  if (redis && edge) {
    cached = { up: true, reason: "stack reachable" };
  } else {
    const missing = [
      !redis ? `redis(${env.redis.host}:${env.redis.port})` : null,
      !edge ? `edge(${env.edge.host}:${env.edge.port})` : null,
    ]
      .filter(Boolean)
      .join(" + ");
    cached = {
      up: false,
      reason: `stack not reachable — ${missing} down. Bring it up: \`docker compose up -d\` (see __TEST__/load/README.md).`,
    };
  }
  return cached;
}
