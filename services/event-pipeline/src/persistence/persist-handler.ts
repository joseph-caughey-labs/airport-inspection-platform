import { withTransaction, type PgPool } from "@aip/postgres-client";
import { SensorFrameEvent } from "@aip/shared-contracts";
import { type ConsumerHandler } from "../consumers/types.js";

export interface PersistHandlerOptions {
  pool: PgPool;
  /** Channel prefix; the airport id is appended (e.g. "events.broadcast.<uuid>"). */
  broadcastChannelPrefix?: string;
  /** Default broadcast airport id when the frame doesn't carry one in metadata yet. */
  defaultAirportId?: string;
}

/**
 * Concrete inner handler for the consumer pipeline. Persists the
 * sensor event AND enqueues an outbox row for the broadcaster in one
 * transaction, using the event_id as the idempotency anchor.
 *
 * - On idempotency-key collision (re-run / race with dedup window),
 *   the INSERT is a no-op. The outbox row is also skipped so we never
 *   double-publish.
 * - The actual Redis publish lives in the OutboxWorker — this handler
 *   only commits the write side. The outbox is the contract between
 *   the synchronous write path and the asynchronous publish path.
 */
export function createPersistHandler(opts: PersistHandlerOptions): ConsumerHandler {
  const prefix = opts.broadcastChannelPrefix ?? "events.broadcast";
  return {
    name: "sensor-frames",
    channel: "sensor.frame.captured",
    async handle(rawPayload, ctx) {
      let json: unknown;
      try {
        json = JSON.parse(rawPayload);
      } catch (err) {
        throw new Error(
          `malformed JSON on sensor.frame.captured: ${err instanceof Error ? err.message : "parse failure"}`,
        );
      }
      const parsed = SensorFrameEvent.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue ? issue.path.join(".") : "<root>";
        throw new Error(`schema violation at ${path}: ${issue?.message ?? "unknown"}`);
      }
      const event = parsed.data;
      const airportId = opts.defaultAirportId;
      const channel = airportId ? `${prefix}.${airportId}` : prefix;

      await withTransaction(opts.pool, async (client) => {
        const ins = await client.query(
          `INSERT INTO sensor_events
             (event_id, sensor_id, sensor_type, frame_id, captured_at,
              geo_lat, geo_lng, geo_alt_m, airport_id, metadata, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            event.event_id,
            event.payload.sensor_id,
            event.payload.sensor_type,
            event.payload.frame_id,
            event.payload.captured_at,
            event.payload.geo.lat,
            event.payload.geo.lng,
            event.payload.geo.alt_m ?? null,
            airportId ?? null,
            JSON.stringify(event.payload.metadata),
            event.idempotency_key ?? event.event_id,
          ],
        );
        if (ins.rowCount === 0) {
          // Duplicate by idempotency_key — do NOT enqueue outbox (already published once).
          ctx.logger.debug(
            { idempotency_key: event.idempotency_key, frame_id: event.payload.frame_id },
            "sensor_events INSERT collided; skipping outbox",
          );
          return;
        }
        await client.query(`INSERT INTO event_outbox (channel, payload) VALUES ($1, $2)`, [
          channel,
          rawPayload,
        ]);
      });
    },
  };
}
