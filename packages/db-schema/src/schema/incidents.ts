import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { airports } from "./airports.js";
import { runways } from "./runways.js";
import { users } from "./users.js";

export const incidents = pgTable("incidents", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v4()`),
  airportId: uuid("airport_id")
    .notNull()
    .references(() => airports.id, { onDelete: "restrict" }),
  runwayId: uuid("runway_id").references(() => runways.id, {
    onDelete: "set null",
  }),
  // severity: critical | high | medium | low | info
  severity: text("severity").notNull(),
  // status: new | acknowledged | assigned | in_progress | resolved | escalated | archived | rejected
  status: text("status").notNull().default("new"),
  title: varchar("title", { length: 300 }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>(),
  acknowledgedBy: uuid("acknowledged_by").references(() => users.id, {
    onDelete: "set null",
  }),
  acknowledgedAt: timestamp("acknowledged_at", {
    withTimezone: true,
    mode: "string",
  }),
  assignedTo: uuid("assigned_to").references(() => users.id, {
    onDelete: "set null",
  }),
  resolvedAt: timestamp("resolved_at", {
    withTimezone: true,
    mode: "string",
  }),
  // Idempotency on the event-driven creation path. Unique partial index
  // is created in the SQL migration so NULL keys coexist freely.
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`),
});

export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncidentRow = typeof incidents.$inferInsert;
