import { sql } from "drizzle-orm";
import {
  bigserial,
  char,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Append-only audit log. The DB role used by services has UPDATE and
 * DELETE revoked on this table (see migration 0001 + ADR 0010). The
 * `prev_hash` + `entry_hash` columns form a tamper-evident chain.
 */
export const auditEvents = pgTable("audit_events", {
  // bigserial — strictly increasing surrogate key for deterministic
  // ordering even when timestamps tie at sub-ms granularity.
  seq: bigserial("seq", { mode: "bigint" }).primaryKey(),
  eventId: uuid("event_id")
    .notNull()
    .unique()
    .default(sql`uuid_generate_v4()`),
  occurredAt: timestamp("occurred_at", {
    withTimezone: true,
    mode: "string",
  })
    .notNull()
    .default(sql`now()`),
  // The originating service (sensor-gateway, validation-engine, etc.).
  source: varchar("source", { length: 100 }).notNull(),
  // Discriminator (e.g. "incident.acknowledged", "review.approved").
  eventType: varchar("event_type", { length: 200 }).notNull(),
  // Actor: user id when known; null for system-emitted events.
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  // Subject of the audit entry (incident id, validation run id, etc.).
  subjectId: varchar("subject_id", { length: 200 }),
  // Full payload of the event — never redacted at write time; redaction is a query-time concern.
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  // Hash chain: entry_hash = sha256(prev_hash || canonical_json(this_row_minus_hashes))
  // First row has prev_hash = '' (empty string) or a fixed seed.
  prevHash: char("prev_hash", { length: 64 }),
  entryHash: char("entry_hash", { length: 64 }).notNull(),
  // Correlation id threads a single logical operation across services.
  correlationId: uuid("correlation_id"),
  // Optional reason/rationale text — used by reviewer overrides.
  rationale: text("rationale"),
});

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
