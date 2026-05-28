import { type PgPool } from "@aip/postgres-client";

export interface HydratorOptions {
  pool: PgPool;
  /** Max rows pulled on connect. Default 50, capped at MAX_LIMIT. */
  defaultLimit?: number;
  /** Max rows replayed by `hydrateSince` (resume). Default 500, capped at MAX_RESUME. */
  defaultResumeLimit?: number;
}

export interface HydrationFrame {
  /**
   * The persisted event_id; the client uses this as `last_event_id`
   * after the hydration burst completes so reconnect resume can skip
   * ahead on the next connection.
   */
  event_id: string;
  /** ISO-8601 from sensor_events.received_at. */
  received_at: string;
  /** Reconstructed WS envelope payload — same shape the live feed emits. */
  message: string;
}

/**
 * Result of a resume-style hydrate. `mode` tells the route whether
 * the client got real resume frames or fell back to the default
 * tail because the cursor was unknown (e.g. dropped from the
 * retention window). The frontend uses it to decide whether to flag
 * a gap to the user.
 */
export interface HydrationResult {
  frames: HydrationFrame[];
  mode: "resume" | "resume_fallback" | "resume_capped";
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_RESUME = 1000;
const DEFAULT_RESUME = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  private readonly defaultResumeLimit: number;

  constructor(opts: HydratorOptions) {
    this.pool = opts.pool;
    this.defaultLimit = Math.min(opts.defaultLimit ?? DEFAULT_LIMIT, MAX_LIMIT);
    this.defaultResumeLimit = Math.min(opts.defaultResumeLimit ?? DEFAULT_RESUME, MAX_RESUME);
  }

  /**
   * Reconnect resume. Finds the watermark row for `lastEventId` and
   * returns frames after it, oldest-first, capped at the resume
   * limit. Behavior:
   *   - cursor matches a row → `resume` (rows returned, count <= limit+1)
   *   - cursor matches but rows > limit → `resume_capped` (we return
   *     limit rows; client should display a "history truncated" hint)
   *   - cursor is malformed or no row found → `resume_fallback`,
   *     identical payload to the default tail-hydrate
   *
   * No transaction wrapping is needed because we tolerate either of
   * the two queries seeing a slightly newer state — the worst case is
   * we replay one extra frame, which the client dedupes on event_id.
   */
  async hydrateSince(
    airportId: string,
    lastEventId: string,
    limit?: number,
  ): Promise<HydrationResult> {
    if (!UUID_RE.test(lastEventId)) {
      const frames = await this.hydrate(airportId);
      return { frames, mode: "resume_fallback" };
    }
    const effectiveLimit = Math.min(Math.max(1, limit ?? this.defaultResumeLimit), MAX_RESUME);
    // Pull limit + 1 so we can detect overflow without an extra COUNT.
    const { rows } = await this.pool.query<SensorEventRow>(
      `WITH cursor AS (
         SELECT received_at, event_id
         FROM sensor_events
         WHERE event_id = $2
       )
       SELECT e.event_id, e.sensor_id, e.sensor_type, e.frame_id, e.captured_at,
              e.geo_lat, e.geo_lng, e.geo_alt_m, e.metadata, e.idempotency_key,
              e.received_at
       FROM sensor_events e, cursor
       WHERE e.airport_id = $1
         AND (e.received_at, e.event_id) > (cursor.received_at, cursor.event_id)
       ORDER BY e.received_at ASC, e.event_id ASC
       LIMIT $3`,
      [airportId, lastEventId, effectiveLimit + 1],
    );
    if (rows.length === 0) {
      // Cursor not found in our retention window; fall back so the
      // client at least sees the recent tail.
      const frames = await this.hydrate(airportId);
      return { frames, mode: "resume_fallback" };
    }
    const overflow = rows.length > effectiveLimit;
    const trimmed = overflow ? rows.slice(0, effectiveLimit) : rows;
    return {
      frames: trimmed.map(this.rowToFrame),
      mode: overflow ? "resume_capped" : "resume",
    };
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
    return rows.map(this.rowToFrame);
  }

  private readonly rowToFrame = (r: SensorEventRow): HydrationFrame => ({
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
  });
}
