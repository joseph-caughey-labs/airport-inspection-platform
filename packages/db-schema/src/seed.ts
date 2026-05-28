import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withTransaction, type PgPool } from "@aip/postgres-client";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Default path to the seed JSON. Tests pass an override. Resolves
 * relative to the package source so it works both in dev and inside
 * a Docker image where the workspace tree is preserved.
 */
const DEFAULT_SEED_DIR = resolve(here, "../../../data/seed");

export interface SeedResult {
  airports: number;
  runways: number;
  sensors: number;
  users: number;
}

interface SeedOptions {
  /** Override the seed directory (mostly for tests). */
  seedDir?: string;
}

interface AirportRow {
  id: string;
  icao_code: string;
  iata_code?: string;
  name: string;
  city: string;
  country: string;
  timezone: string;
  created_at: string;
}

interface RunwayRow {
  id: string;
  airport_id: string;
  designator: string;
  paired_designator: string;
  length_m: number;
  width_m: number;
  surface: string;
  status: string;
  created_at: string;
}

interface SensorRow {
  id: string;
  airport_id: string;
  type: string;
  lat: number;
  lng: number;
  alt_m?: number;
  status: string;
  last_seen_at?: string;
  created_at: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  organization: string;
  created_at: string;
}

async function loadJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

/**
 * Load `data/seed/*.json` and insert into the platform's tables.
 *
 * - Order respects FKs (airports → runways/sensors, users last).
 * - Idempotent: `ON CONFLICT (id) DO NOTHING` so re-runs do nothing.
 * - Wrapped in a single transaction — partial seeds never land.
 */
export async function seedFromJson(pool: PgPool, opts: SeedOptions = {}): Promise<SeedResult> {
  const seedDir = opts.seedDir ?? DEFAULT_SEED_DIR;

  const [airports, runways, sensors, users] = await Promise.all([
    loadJson<AirportRow[]>(resolve(seedDir, "airports.json")),
    loadJson<RunwayRow[]>(resolve(seedDir, "runways.json")),
    loadJson<SensorRow[]>(resolve(seedDir, "sensors.json")),
    loadJson<UserRow[]>(resolve(seedDir, "users.json")),
  ]);

  return await withTransaction(pool, async (client) => {
    let airportCount = 0;
    for (const a of airports) {
      const r = await client.query(
        `INSERT INTO airports (id, icao_code, iata_code, name, city, country, timezone, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id,
          a.icao_code,
          a.iata_code ?? null,
          a.name,
          a.city,
          a.country,
          a.timezone,
          a.created_at,
        ],
      );
      airportCount += r.rowCount ?? 0;
    }

    let userCount = 0;
    for (const u of users) {
      const r = await client.query(
        `INSERT INTO users (id, email, name, role, organization, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.email, u.name, u.role, u.organization, u.created_at],
      );
      userCount += r.rowCount ?? 0;
    }

    let runwayCount = 0;
    for (const w of runways) {
      const r = await client.query(
        `INSERT INTO runways (id, airport_id, designator, paired_designator, length_m, width_m, surface, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          w.id,
          w.airport_id,
          w.designator,
          w.paired_designator,
          w.length_m,
          w.width_m,
          w.surface,
          w.status,
          w.created_at,
        ],
      );
      runwayCount += r.rowCount ?? 0;
    }

    let sensorCount = 0;
    for (const s of sensors) {
      const r = await client.query(
        `INSERT INTO sensors (id, airport_id, type, lat, lng, alt_m, status, last_seen_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          s.id,
          s.airport_id,
          s.type,
          s.lat,
          s.lng,
          s.alt_m ?? null,
          s.status,
          s.last_seen_at ?? null,
          s.created_at,
        ],
      );
      sensorCount += r.rowCount ?? 0;
    }

    return {
      airports: airportCount,
      runways: runwayCount,
      sensors: sensorCount,
      users: userCount,
    };
  });
}
