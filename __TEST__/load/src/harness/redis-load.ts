/**
 * Redis-backed load generator.
 *
 * Telemetry enters the platform as a `sensor.frame.captured` publish on
 * Redis (there is no HTTP ingestion endpoint); the event-pipeline
 * subscribes, dedups, prioritizes, persists, and re-broadcasts to
 * `events.broadcast.<airport>`. This module builds wire-valid frames
 * (matching `@aip/shared-contracts` `SensorFrameEvent`) and drives them
 * at a target rate.
 */
import { SensorFrameEvent } from "@aip/shared-contracts";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { channels, env } from "./env.js";

export interface LoadPublisher {
  raw: Redis;
  /** Publish one wire-valid sensor frame to `sensor.frame.captured`. */
  publishFrame(overrides?: Partial<FrameInput>): Promise<number>;
  /** Publish a pre-built broadcast envelope to `events.broadcast.<airport>`. */
  publishBroadcast(airportId: string, envelope: BroadcastEnvelope): Promise<number>;
  disconnect(): void;
}

export interface FrameInput {
  sensorId: string;
  frameId: string;
  capturedAt: string;
}

export interface BroadcastEnvelope {
  event_id: string;
  event_type: string;
  schema_version: "v1";
  timestamp: string;
  payload: Record<string, unknown>;
}

export async function connectLoadPublisher(): Promise<LoadPublisher> {
  const redis = new Redis({
    host: env.redis.host,
    port: env.redis.port,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // Scenarios 04/05 deliberately take Redis down mid-run; a publish then
  // rejects (which the rate driver counts as `failed`). Swallow the
  // socket-level 'error' event so it doesn't surface as noise.
  redis.on("error", () => {});

  async function publishFrame(overrides: Partial<FrameInput> = {}): Promise<number> {
    const frameId = overrides.frameId ?? randomUUID();
    const now = new Date().toISOString();
    // event_id + frame_id + idempotency_key all unique per call so the
    // pipeline's 5s dedup window doesn't collapse a high-rate stream.
    const event = {
      event_id: randomUUID(),
      event_type: "sensor.frame.captured" as const,
      schema_version: "v1",
      source: { service: "load-tests" },
      timestamp: now,
      idempotency_key: `frame:${frameId}`,
      payload: {
        sensor_id: overrides.sensorId ?? "CAM-RWY10L-01",
        sensor_type: "camera",
        frame_id: frameId,
        captured_at: overrides.capturedAt ?? now,
        geo: { lat: 37.6213, lng: -122.379 },
        metadata: { width: 1920, height: 1080, source: "load-tests" },
      },
    };
    // Validate in-process so a contract drift fails the harness, not the
    // service silently dropping malformed frames into consumer_errors.
    SensorFrameEvent.parse(event);
    return redis.publish(channels.sensorFrameCaptured, JSON.stringify(event));
  }

  function publishBroadcast(airportId: string, envelope: BroadcastEnvelope): Promise<number> {
    return redis.publish(channels.broadcastFor(airportId), JSON.stringify(envelope));
  }

  return { raw: redis, publishFrame, publishBroadcast, disconnect: () => redis.disconnect() };
}

/** A broadcast envelope shaped like what ws-broadcaster fans out. */
export function sensorBroadcastEnvelope(frameId = randomUUID()): BroadcastEnvelope {
  const now = new Date().toISOString();
  return {
    event_id: randomUUID(),
    event_type: "sensor.frame.captured",
    schema_version: "v1",
    timestamp: now,
    payload: { sensor_id: "CAM-RWY10L-01", frame_id: frameId, captured_at: now },
  };
}

export interface RateResult {
  attempted: number;
  acked: number;
  failed: number;
  elapsedMs: number;
  achievedRate: number;
}

/**
 * Drive `total` publishes at a target rate (frames/sec) using fixed-size
 * ticks. Returns attempted/acked counts and the achieved rate — a
 * sustained achievedRate well below target is itself a backpressure
 * signal worth asserting on.
 */
export async function driveAtRate(
  publish: () => Promise<number>,
  opts: { total: number; ratePerSec: number },
): Promise<RateResult> {
  const { total, ratePerSec } = opts;
  const tickMs = 50;
  const perTick = Math.max(1, Math.round((ratePerSec * tickMs) / 1000));
  const start = Date.now();
  let attempted = 0;
  let acked = 0;
  let failed = 0;

  while (attempted < total) {
    const tickStart = Date.now();
    const batch = Math.min(perTick, total - attempted);
    const results = await Promise.allSettled(Array.from({ length: batch }, () => publish()));
    for (const r of results) {
      attempted++;
      if (r.status === "fulfilled") acked++;
      else failed++;
    }
    const drift = tickMs - (Date.now() - tickStart);
    if (drift > 0 && attempted < total) await sleep(drift);
  }

  const elapsedMs = Date.now() - start;
  return { attempted, acked, failed, elapsedMs, achievedRate: (acked / elapsedMs) * 1000 };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
