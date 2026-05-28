import { AirportList, RunwayList, SensorList } from "~/types/airport";
import type { Airport, Runway, Sensor } from "~/types/airport";

/**
 * Loads the static seed JSON files served out of `/seed/*` and parses
 * them through the zod schemas so a typo at the source surfaces as a
 * typed error instead of a silent UI bug.
 *
 * Bundles per-airport grouping so callers can write
 * `runwaysFor(airportId)` without re-implementing the filter.
 *
 * `server: false` makes the fetch client-only. The seed lives under
 * `apps/web/public/seed/` and is served by Nitro at HTTP level, but
 * the SSR `$fetch` resolves relative URLs against a host without the
 * dev port, which 404s. Reference-data lands as a real service in
 * Phase 3 — at that point this becomes a proper server-tolerant fetch.
 */
export interface SeedBundle {
  airports: Airport[];
  runways: Runway[];
  sensors: Sensor[];
  airportById(id: string): Airport | undefined;
  runwaysFor(airportId: string): Runway[];
  sensorsFor(airportId: string): Sensor[];
}

async function fetchSeed<T>(path: string, schema: { parse: (raw: unknown) => T }): Promise<T> {
  const raw = await $fetch<unknown>(path);
  return schema.parse(raw);
}

export function useSeedData() {
  return useAsyncData<SeedBundle>(
    "aip-seed",
    async () => {
      const [airports, runways, sensors] = await Promise.all([
        fetchSeed("/seed/airports.json", AirportList),
        fetchSeed("/seed/runways.json", RunwayList),
        fetchSeed("/seed/sensors.json", SensorList),
      ]);
      return buildSeedBundle({ airports, runways, sensors });
    },
    { server: false },
  );
}

/** Pure factory — exported so unit tests can exercise the lookups without HTTP. */
export function buildSeedBundle(input: {
  airports: Airport[];
  runways: Runway[];
  sensors: Sensor[];
}): SeedBundle {
  const airportIndex = new Map(input.airports.map((a) => [a.id, a]));
  const runwaysByAirport = new Map<string, Runway[]>();
  for (const r of input.runways) {
    const list = runwaysByAirport.get(r.airport_id) ?? [];
    list.push(r);
    runwaysByAirport.set(r.airport_id, list);
  }
  const sensorsByAirport = new Map<string, Sensor[]>();
  for (const s of input.sensors) {
    const list = sensorsByAirport.get(s.airport_id) ?? [];
    list.push(s);
    sensorsByAirport.set(s.airport_id, list);
  }
  return {
    airports: input.airports,
    runways: input.runways,
    sensors: input.sensors,
    airportById: (id) => airportIndex.get(id),
    runwaysFor: (airportId) => runwaysByAirport.get(airportId) ?? [],
    sensorsFor: (airportId) => sensorsByAirport.get(airportId) ?? [],
  };
}

export type { Airport, Runway, Sensor };
