import { type PgPool } from "@aip/postgres-client";

export interface HydratorOptions {
  pool: PgPool;
  /** Max rows pulled on connect. Default 50, capped at MAX_LIMIT. */
  defaultLimit?: number;
}

export interface HydrationFrame {
  /**
   * The persisted event_id; the client uses this as `last_event_id`
   * after the hydration burst completes so reconnect resume in T-210
   * can skip ahead.
   */
  event_id: string;
  /** ISO-8601 from sensor_events.received_at. */
  received_at: string;
  /** Reconstructed WS envelope payload — same shape the live feed emits. */
  message: string;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

interface SensorEventRow {
  event_id: string;
  sensor_id: string;
  sensor_type: string;
  frame_id: string;
  captured_at: string;
  geo_lat: number;
  geo_lng: number;
  geo_alt_m: number | null;
  metadata: Record<string, unknown>;
  idempotency_key: string;
  received_at: string;
}

/**
 * On-connect hydrator. Pulls the last N sensor events for an airport
 * out of `sensor_events` and rebuilds them as `sensor.frame.captured`
 * WS envelopes so the live feed and the hydration burst are byte-shape
 * identical from the client's perspective.
 *
 * Ordering: ascending by `received_at`, then `event_id` for ties. The
 * client receives the oldest row first and the freshest row last,
 * matching the natural display order of a tailing feed.
 */
export class FrameHydrator {
  private readonly pool: PgPool;
  private readonly defaultLimit: number;

  constructor(opts: HydratorOptions) {
    this.pool = opts.pool;
    this.defaultLimit = Math.min(opts.defaultLimit ?? DEFAULT_LIMIT, MAX_LIMIT);
  }

  async hydrate(airportId: string, limit?: number): Promise<HydrationFrame[]> {
    const effectiveLimit = Math.min(Math.max(1, limit ?? this.defaultLimit), MAX_LIMIT);
    const { rows } = await this.pool.query<SensorEventRow>(
      `SELECT event_id, sensor_id, sensor_type, frame_id, captured_at,
              geo_lat, geo_lng, geo_alt_m, metadata, idempotency_key, received_at
       FROM sensor_events
       WHERE airport_id = $1
       ORDER BY received_at DESC, event_id DESC
       LIMIT $2`,
      [airportId, effectiveLimit],
    );
    // We selected DESC to take the freshest N; reverse for ascending replay.
    rows.reverse();
    return rows.map((r) => ({
      event_id: r.event_id,
      received_at: r.received_at,
      message: JSON.stringify({
        type: "sensor.frame.captured",
        schema_version: "v1",
        timestamp: r.received_at,
        last_event_id: r.event_id,
        payload: {
          event_id: r.event_id,
          sensor_id: r.sensor_id,
          sensor_type: r.sensor_type,
          frame_id: r.frame_id,
          captured_at: r.captured_at,
          geo: {
            lat: r.geo_lat,
            lng: r.geo_lng,
            ...(r.geo_alt_m !== null ? { alt_m: r.geo_alt_m } : {}),
          },
          metadata: r.metadata,
        },
      }),
    }));
  }
}
