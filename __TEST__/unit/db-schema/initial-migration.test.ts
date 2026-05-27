import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(here, "../../../packages/db-schema/src/migrations/0001_initial.sql");

let sql: string;

async function readMigration(): Promise<string> {
  if (!sql) sql = await readFile(migrationPath, "utf8");
  return sql;
}

describe("0001_initial migration", () => {
  it("creates the six core tables", async () => {
    const s = await readMigration();
    for (const table of ["airports", "runways", "sensors", "users", "incidents", "audit_events"]) {
      expect(s).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
    }
  });

  it("revokes UPDATE/DELETE/TRUNCATE on audit_events", async () => {
    const s = await readMigration();
    expect(s).toMatch(/REVOKE UPDATE, DELETE ON audit_events/);
    expect(s).toMatch(/REVOKE TRUNCATE ON audit_events/);
  });

  it("constrains airport codes at the DB level", async () => {
    const s = await readMigration();
    expect(s).toMatch(/airports_icao_code_chk CHECK \(icao_code ~ '\^\[A-Z\]\{4\}\$'\)/);
    expect(s).toMatch(/airports_country_chk CHECK \(country ~ '\^\[A-Z\]\{2\}\$'\)/);
  });

  it("constrains runway designators to the NN[LRC]? convention", async () => {
    const s = await readMigration();
    expect(s).toMatch(
      /runways_designator_chk CHECK \(designator ~ '\^\(0\[1-9\]\|\[12\]\[0-9\]\|3\[0-6\]\)\[LRC\]\?\$'\)/,
    );
  });

  it("constrains sensor ids to TYPE-LOCATION-INDEX", async () => {
    const s = await readMigration();
    expect(s).toMatch(
      /sensors_id_chk CHECK \(id ~ '\^\[A-Z\]\{2,4\}-\[A-Z0-9\]\+-\[0-9\]\{2,3\}\$'\)/,
    );
  });

  it("mirrors the shared-contracts enums as CHECK constraints", async () => {
    const s = await readMigration();
    // Severity
    expect(s).toMatch(/severity IN \('critical','high','medium','low','info'\)/);
    // Incident status
    expect(s).toMatch(
      /status IN \('new','acknowledged','assigned','in_progress','resolved','escalated','archived','rejected'\)/,
    );
    // Sensor type
    expect(s).toMatch(/type IN \('camera','lidar','gps','imu','weather','perimeter'\)/);
    // Sensor status
    expect(s).toMatch(/status IN \('online','degraded','offline'\)/);
    // User role
    expect(s).toMatch(/role IN \('operator','reviewer','admin'\)/);
  });

  it("creates a partial unique index on incidents.idempotency_key", async () => {
    const s = await readMigration();
    expect(s).toMatch(
      /CREATE UNIQUE INDEX incidents_idempotency_key_uniq[\s\S]+WHERE idempotency_key IS NOT NULL/,
    );
  });

  it("creates indexes on common operator-dashboard query patterns", async () => {
    const s = await readMigration();
    expect(s).toMatch(/CREATE INDEX incidents_airport_status_idx/);
    expect(s).toMatch(/CREATE INDEX incidents_created_at_idx/);
    expect(s).toMatch(/CREATE INDEX audit_events_subject_idx/);
    expect(s).toMatch(/CREATE INDEX audit_events_correlation_idx/);
  });

  it("uses timestamptz for every datetime column", async () => {
    const s = await readMigration();
    expect(s).not.toMatch(/\btimestamp\b(?! ?with)/i);
    expect(s).toMatch(/timestamptz/);
  });

  it("creates the set_updated_at trigger for incidents", async () => {
    const s = await readMigration();
    expect(s).toMatch(/CREATE TRIGGER incidents_set_updated_at/);
    expect(s).toMatch(/CREATE OR REPLACE FUNCTION set_updated_at/);
  });
});
