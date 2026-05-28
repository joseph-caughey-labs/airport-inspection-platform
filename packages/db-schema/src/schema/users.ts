import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v4()`),
  email: varchar("email", { length: 320 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  // role: operator | reviewer | admin
  role: text("role").notNull(),
  organization: varchar("organization", { length: 200 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
