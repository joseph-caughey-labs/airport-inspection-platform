import { describe, expect, it } from "vitest";
import { buildSeedBundle } from "~/composables/useSeedData";
import type { Airport, Runway, Sensor } from "~/types/airport";

const SFO: Airport = {
  id: "11111111-1111-1111-1111-aaaaaaaaaaaa",
  icao_code: "KSFO",
  iata_code: "SFO",
  name: "San Francisco International",
  city: "San Francisco",
  country: "US",
  timezone: "America/Los_Angeles",
  lat: 37.6189,
  lng: -122.375,
  default_zoom: 13.2,
  created_at: "2026-01-01T00:00:00.000Z",
};
const JFK: Airport = {
  ...SFO,
  id: "11111111-1111-1111-1111-bbbbbbbbbbbb",
  icao_code: "KJFK",
  iata_code: "JFK",
  name: "JFK",
  city: "New York",
  lat: 40.6413,
  lng: -73.7781,
};

const sfoRwy = (i: number): Runway => ({
  id: `r-sfo-${i}`,
  airport_id: SFO.id,
  designator: `10${i}`,
  paired_designator: `28${i}`,
  length_m: 3000,
  width_m: 60,
  surface: "asphalt",
  status: "open",
  lat_start: 37.63,
  lng_start: -122.39,
  lat_end: 37.61,
  lng_end: -122.36,
  created_at: "2026-01-01T00:00:00.000Z",
});

const sfoSensor = (id: string): Sensor => ({
  id,
  airport_id: SFO.id,
  type: "camera",
  lat: 37.62,
  lng: -122.37,
  status: "online",
  last_seen_at: "2026-05-27T15:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
});

describe("buildSeedBundle", () => {
  it("indexes airports for O(1) lookup by id", () => {
    const b = buildSeedBundle({ airports: [SFO, JFK], runways: [], sensors: [] });
    expect(b.airportById(SFO.id)?.iata_code).toBe("SFO");
    expect(b.airportById(JFK.id)?.iata_code).toBe("JFK");
    expect(b.airportById("nope")).toBeUndefined();
  });

  it("groups runways by airport_id", () => {
    const b = buildSeedBundle({
      airports: [SFO, JFK],
      runways: [sfoRwy(1), sfoRwy(2), { ...sfoRwy(3), airport_id: JFK.id }],
      sensors: [],
    });
    expect(b.runwaysFor(SFO.id)).toHaveLength(2);
    expect(b.runwaysFor(JFK.id)).toHaveLength(1);
  });

  it("groups sensors by airport_id", () => {
    const b = buildSeedBundle({
      airports: [SFO, JFK],
      runways: [],
      sensors: [
        sfoSensor("CAM-1"),
        sfoSensor("CAM-2"),
        { ...sfoSensor("CAM-3"), airport_id: JFK.id },
      ],
    });
    expect(b.sensorsFor(SFO.id).map((s) => s.id)).toEqual(["CAM-1", "CAM-2"]);
    expect(b.sensorsFor(JFK.id).map((s) => s.id)).toEqual(["CAM-3"]);
  });

  it("returns [] for airports with no runways or sensors", () => {
    const b = buildSeedBundle({ airports: [SFO, JFK], runways: [], sensors: [] });
    expect(b.runwaysFor(SFO.id)).toEqual([]);
    expect(b.sensorsFor(JFK.id)).toEqual([]);
  });

  it("preserves insertion order within each airport's runway list", () => {
    const r1 = sfoRwy(1);
    const r2 = sfoRwy(2);
    const r3 = sfoRwy(3);
    const b = buildSeedBundle({ airports: [SFO], runways: [r3, r1, r2], sensors: [] });
    expect(b.runwaysFor(SFO.id).map((r) => r.id)).toEqual(["r-sfo-3", "r-sfo-1", "r-sfo-2"]);
  });
});
