import { sql } from "drizzle-orm";
import { doublePrecision, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { airports } from "./airports.js";

export const runways = pgTable("runways", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v4()`),
  airportId: uuid("airport_id")
    .notNull()
    .references(() => airports.id, { onDelete: "cascade" }),
  // e.g. "09L"; matches RunwayDesignator from @aip/shared-contracts
  designator: varchar("designator", { length: 4 }).notNull(),
  pairedDesignator: varchar("paired_designator", { length: 4 }).notNull(),
  lengthM: doublePrecision("length_m").notNull(),
  widthM: doublePrecision("width_m").notNull(),
  // surface: asphalt | concrete | gravel | turf | other (enforced by CHECK in migration)
  surface: text("surface").notNull(),
  // status: open | closed | restricted | maintenance (enforced by CHECK in migration)
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`),
});

export type RunwayRow = typeof runways.$inferSelect;
export type NewRunwayRow = typeof runways.$inferInsert;
