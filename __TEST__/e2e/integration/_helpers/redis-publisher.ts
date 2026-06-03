/**
 * Real-Redis publisher for the integration tier.
 *
 * The mocked tier (`__TEST__/e2e/fixtures/ws-fixture.ts`) intercepts
 * the WebSocket via Playwright's `routeWebSocket`. The integration
 * tier doesn't intercept anything — it publishes to the live Redis
 * the compose stack is running, and lets the real
 * ws-broadcaster's `RedisBridge` pick the frame up and fan it to
 * the connected browser via the actual WS pipeline.
 *
 * Channel taxonomy (matches `services/ws-broadcaster/src/redis-bridge.ts`):
 *
 *   events.broadcast.<airport_id>
 *
 * Envelope shape on the wire (bridge unwraps `payload` + re-emits
 * with `type` derived from `event_type`):
 *
 *   {
 *     event_id:       <uuid>,
 *     event_type:     "sensor.frame.captured" | "ai.detection.<class>.emitted" | ...,
 *     schema_version: "v1",
 *     timestamp:      <iso>,
 *     payload:        { ... event-specific shape ... }
 *   }
 *
 * Usage:
 *
 *   const pub = await connectRedisPublisher();
 *   await pub.publishToAirport(AIRPORT_ID, sensorFrameEnvelope({...}));
 *   await pub.disconnect();
 */
import Redis from "ioredis";
import { randomUUID } from "node:crypto";

export interface RedisPublisher {
  publishToAirport(airportId: string, envelope: BroadcastEnvelope): Promise<number>;
  disconnect(): void;
}

export interface BroadcastEnvelope {
  event_id: string;
  event_type: string;
  schema_version: "v1";
  timestamp: string;
  payload: Record<string, unknown>;
}

export async function connectRedisPublisher(
  opts: {
    host?: string;
    port?: number;
  } = {},
): Promise<RedisPublisher> {
  const redis = new Redis({
    host: opts.host ?? process.env["INTEGRATION_REDIS_HOST"] ?? "127.0.0.1",
    port: opts.port ?? Number(process.env["INTEGRATION_REDIS_PORT"] ?? 6379),
    // Fail fast so a spec doesn't sit waiting on a broken Redis.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // Wait until ready so the first publish doesn't race the handshake.
  await new Promise<void>((resolve, reject) => {
    redis.once("ready", () => resolve());
    redis.once("error", (err) => reject(err));
  });
  return {
    async publishToAirport(airportId, envelope) {
      const channel = `events.broadcast.${airportId}`;
      return redis.publish(channel, JSON.stringify(envelope));
    },
    disconnect() {
      redis.disconnect();
    },
  };
}

// ── Envelope builders ────────────────────────────────────────────
// Mirror the shapes the mocked tier's `ws-fixture.ts` produces, but
// emit the BRIDGE-side envelope (with top-level `event_type`, not
// the post-bridge `type` the WS client sees).

export function sensorFrameEnvelope(opts: {
  sensorId: string;
  frameId: string;
  capturedAt?: string;
  geo?: { lat: number; lng: number; alt_m?: number };
  eventId?: string;
}): BroadcastEnvelope {
  const captured = opts.capturedAt ?? new Date().toISOString();
  return {
    event_id: opts.eventId ?? randomUUID(),
    event_type: "sensor.frame.captured",
    schema_version: "v1",
    timestamp: captured,
    payload: {
      sensor_id: opts.sensorId,
      sensor_type: "camera",
      frame_id: opts.frameId,
      captured_at: captured,
      geo: opts.geo ?? { lat: 37.6213, lng: -122.379, alt_m: 4 },
      metadata: { width: 1920, height: 1080 },
    },
  };
}

/**
 * AI detection envelope as the publish-side emits it. Mirrors the
 * mocked tier's `aiDetection({...})` from `ws-fixture.ts` but in
 * BRIDGE-side shape (top-level `event_type`, the bridge rewrites to
 * message `type`).
 *
 * `confidence` is the CALIBRATED value the bridge passes through.
 * The frontend decoder flags the alert with LOW CONF when this is
 * below the threshold (~0.5), so pass < 0.5 to exercise the badge.
 */
export function aiDetectionEnvelope(opts: {
  sensorId: string;
  detectionId: string;
  frameId: string;
  detectionClass: "fod" | "crack" | "snowbank" | "wildlife" | "anomaly";
  confidence: number;
  severityHint: "critical" | "high" | "medium" | "low" | "info";
  bbox?: { x: number; y: number; w: number; h: number };
  capturedAt?: string;
  eventId?: string;
}): BroadcastEnvelope {
  const captured = opts.capturedAt ?? new Date().toISOString();
  return {
    event_id: opts.eventId ?? randomUUID(),
    event_type: `ai.detection.${opts.detectionClass}.emitted`,
    schema_version: "v1",
    timestamp: captured,
    payload: {
      detection_id: opts.detectionId,
      sensor_id: opts.sensorId,
      frame_id: opts.frameId,
      detection_class: opts.detectionClass,
      confidence: opts.confidence,
      severity_hint: opts.severityHint,
      ...(opts.bbox ? { bbox: opts.bbox } : {}),
      captured_at: captured,
      geo: { lat: 37.6213, lng: -122.379, alt_m: 4 },
    },
  };
}
