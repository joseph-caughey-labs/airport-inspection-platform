import { sql } from "drizzle-orm";
import { doublePrecision, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { airports } from "./airports.js";

export const sensors = pgTable("sensors", {
  // Operational sensor id (TYPE-LOCATION-INDEX), not a UUID — matches the
  // physical naming convention used by airport operations.
  id: varchar("id", { length: 64 }).primaryKey(),
  airportId: uuid("airport_id")
    .notNull()
    .references(() => airports.id, { onDelete: "cascade" }),
  // sensor type: camera | lidar | gps | imu | weather | perimeter
  type: text("type").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  altM: doublePrecision("alt_m"),
  // status: online | degraded | offline
  status: text("status").notNull(),
  lastSeenAt: timestamp("last_seen_at", {
    withTimezone: true,
    mode: "string",
  }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`),
});

export type SensorRow = typeof sensors.$inferSelect;
export type NewSensorRow = typeof sensors.$inferInsert;
