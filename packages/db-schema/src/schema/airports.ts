import { sql } from "drizzle-orm";
import { char, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const airports = pgTable("airports", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v4()`),
  icaoCode: char("icao_code", { length: 4 }).notNull().unique(),
  iataCode: char("iata_code", { length: 3 }),
  name: varchar("name", { length: 200 }).notNull(),
  city: varchar("city", { length: 100 }).notNull(),
  country: char("country", { length: 2 }).notNull(), // ISO 3166-1 alpha-2
  timezone: text("timezone").notNull(), // IANA tz, e.g. "America/Los_Angeles"
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`),
});

export type AirportRow = typeof airports.$inferSelect;
export type NewAirportRow = typeof airports.$inferInsert;
