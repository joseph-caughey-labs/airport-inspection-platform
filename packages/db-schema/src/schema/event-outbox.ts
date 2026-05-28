import { sql } from "drizzle-orm";
import { bigserial, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Outbox pattern table. Each row is a pending publish to a Redis
 * channel. The persistence handler INSERTs here in the same
 * transaction as the `sensor_events` row; the outbox worker drains
 * rows where `published_at IS NULL` and updates them.
 *
 * Partial index on `id WHERE published_at IS NULL` keeps the worker's
 * poll query cheap as the table grows.
 */
export const eventOutbox = pgTable("event_outbox", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  channel: varchar("channel", { length: 200 }).notNull(),
  payload: text("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
  attempts: integer("attempts").notNull().default(0),
});

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type NewEventOutboxRow = typeof eventOutbox.$inferInsert;
