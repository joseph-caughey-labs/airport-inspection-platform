import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  here,
  "../../../packages/db-schema/src/migrations/0002_sensor_events_outbox.sql",
);

let sql: string;
async function readMigration(): Promise<string> {
  if (!sql) sql = await readFile(migrationPath, "utf8");
  return sql;
}

describe("0002_sensor_events_outbox migration", () => {
  it("creates sensor_events and event_outbox tables", async () => {
    const s = await readMigration();
    expect(s).toMatch(/CREATE TABLE sensor_events\b/);
    expect(s).toMatch(/CREATE TABLE event_outbox\b/);
  });

  it("enforces unique idempotency_key on sensor_events", async () => {
    const s = await readMigration();
    expect(s).toMatch(/sensor_events_idempotency_key_uniq UNIQUE \(idempotency_key\)/);
  });

  it("checks sensor_type against the shared-contracts enum", async () => {
    const s = await readMigration();
    expect(s).toMatch(/sensor_type IN \('camera','lidar','gps','imu','weather','perimeter'\)/);
  });

  it("constrains lat / lng to valid ranges", async () => {
    const s = await readMigration();
    expect(s).toMatch(/geo_lat BETWEEN -90 AND 90/);
    expect(s).toMatch(/geo_lng BETWEEN -180 AND 180/);
  });

  it("creates the partial index for the outbox worker poll query", async () => {
    const s = await readMigration();
    expect(s).toMatch(/CREATE INDEX event_outbox_unpublished_idx[\s\S]+WHERE published_at IS NULL/);
  });

  it("uses timestamptz everywhere", async () => {
    const s = await readMigration();
    expect(s).toMatch(/timestamptz/);
    expect(s).not.toMatch(/\btimestamp\b(?! ?with)/i);
  });

  it("references airports(id) with ON DELETE SET NULL on the optional FK", async () => {
    const s = await readMigration();
    expect(s).toMatch(/airport_id\s+uuid REFERENCES airports\(id\) ON DELETE SET NULL/);
  });
});
