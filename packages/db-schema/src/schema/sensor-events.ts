import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { airports } from "./airports.js";

/**
 * Durable record of every sensor frame that survives the event-pipeline
 * middleware chain (dedup + prioritization). Captured in the same
 * transaction as the outbox enqueue (`event_outbox`).
 *
 * The unique constraint on `idempotency_key` is the at-least-once
 * safety net — duplicate inserts collide cleanly via ON CONFLICT.
 */
export const sensorEvents = pgTable(
  "sensor_events",
  {
    eventId: uuid("event_id").primaryKey(),
    sensorId: varchar("sensor_id", { length: 64 }).notNull(),
    sensorType: text("sensor_type").notNull(),
    frameId: varchar("frame_id", { length: 128 }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "string" }).notNull(),
    geoLat: doublePrecision("geo_lat").notNull(),
    geoLng: doublePrecision("geo_lng").notNull(),
    geoAltM: doublePrecision("geo_alt_m"),
    airportId: uuid("airport_id").references(() => airports.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").notNull().$type<Record<string, unknown>>(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("sensor_events_idempotency_key_uniq").on(
      table.idempotencyKey,
    ),
    sensorReceivedIdx: index("sensor_events_sensor_received_idx").on(
      table.sensorId,
      table.receivedAt,
    ),
    capturedIdx: index("sensor_events_captured_idx").on(table.capturedAt),
    airportIdx: index("sensor_events_airport_idx").on(table.airportId),
  }),
);

export type SensorEventRow = typeof sensorEvents.$inferSelect;
export type NewSensorEventRow = typeof sensorEvents.$inferInsert;
