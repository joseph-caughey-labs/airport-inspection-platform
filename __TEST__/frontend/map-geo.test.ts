import { describe, expect, it } from "vitest";
import {
  computeAirportBounds,
  runwaysToGeoJSON,
  SENSOR_STATUS_STROKE,
  SENSOR_TYPE_COLOR,
  sensorsToGeoJSON,
} from "~/utils/map-geo";
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

const runwayBase: Runway = {
  id: "22222222-1111-1111-1111-aaaaaaaa0001",
  airport_id: SFO.id,
  designator: "10L",
  paired_designator: "28R",
  length_m: 3618,
  width_m: 61,
  surface: "asphalt",
  status: "open",
  lat_start: 37.6305,
  lng_start: -122.3935,
  lat_end: 37.6122,
  lng_end: -122.3577,
  created_at: "2026-01-01T00:00:00.000Z",
};

const sensorBase: Sensor = {
  id: "CAM-RWY10L-01",
  airport_id: SFO.id,
  type: "camera",
  lat: 37.6213,
  lng: -122.379,
  alt_m: 4,
  status: "online",
  last_seen_at: "2026-05-27T15:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("runwaysToGeoJSON", () => {
  it("returns a FeatureCollection with one LineString per runway", () => {
    const out = runwaysToGeoJSON([runwayBase]);
    expect(out.type).toBe("FeatureCollection");
    expect(out.features).toHaveLength(1);
    const f = out.features[0]!;
    expect(f.geometry.type).toBe("LineString");
    expect(f.geometry.coordinates).toEqual([
      [-122.3935, 37.6305],
      [-122.3577, 37.6122],
    ]);
    expect(f.properties.designator).toBe("10L");
    expect(f.properties.status).toBe("open");
  });

  it("emits coords in [lng, lat] order (GeoJSON convention, not [lat, lng])", () => {
    const out = runwaysToGeoJSON([runwayBase]);
    const [[lng, lat]] = out.features[0]!.geometry.coordinates;
    expect(lng).toBe(-122.3935);
    expect(lat).toBe(37.6305);
  });

  it("handles an empty list", () => {
    const out = runwaysToGeoJSON([]);
    expect(out.features).toEqual([]);
  });
});

describe("sensorsToGeoJSON", () => {
  it("assigns color by sensor_type and stroke by status", () => {
    const out = sensorsToGeoJSON([
      { ...sensorBase, type: "camera", status: "online" },
      { ...sensorBase, id: "LDR-1", type: "lidar", status: "offline" },
    ]);
    expect(out.features[0]!.properties.color).toBe(SENSOR_TYPE_COLOR.camera);
    expect(out.features[0]!.properties.stroke).toBe(SENSOR_STATUS_STROKE.online);
    expect(out.features[1]!.properties.color).toBe(SENSOR_TYPE_COLOR.lidar);
    expect(out.features[1]!.properties.stroke).toBe(SENSOR_STATUS_STROKE.offline);
  });

  it("emits Point geometry with [lng, lat] coords", () => {
    const out = sensorsToGeoJSON([sensorBase]);
    expect(out.features[0]!.geometry).toEqual({
      type: "Point",
      coordinates: [-122.379, 37.6213],
    });
  });

  it("preserves the sensor id in feature properties (used by the pulse filter)", () => {
    const out = sensorsToGeoJSON([sensorBase]);
    expect(out.features[0]!.properties.id).toBe("CAM-RWY10L-01");
  });
});

describe("computeAirportBounds", () => {
  it("expands to encompass every runway endpoint", () => {
    const b = computeAirportBounds(SFO, [
      runwayBase,
      {
        ...runwayBase,
        id: "r2",
        lat_start: 37.6285,
        lng_start: -122.3911,
        lat_end: 37.6118,
        lng_end: -122.3593,
      },
    ]);
    expect(b.sw[0]).toBeCloseTo(-122.3935);
    expect(b.sw[1]).toBeCloseTo(37.6118);
    expect(b.ne[0]).toBeCloseTo(-122.3577);
    expect(b.ne[1]).toBeCloseTo(37.6305);
  });

  it("falls back to a small box around the airport when there are no runways", () => {
    const b = computeAirportBounds(SFO, []);
    expect(b.sw[0]).toBeCloseTo(SFO.lng - 0.01);
    expect(b.sw[1]).toBeCloseTo(SFO.lat - 0.01);
    expect(b.ne[0]).toBeCloseTo(SFO.lng + 0.01);
    expect(b.ne[1]).toBeCloseTo(SFO.lat + 0.01);
  });

  it("always returns sw <= ne in both dimensions", () => {
    const b = computeAirportBounds(SFO, [runwayBase]);
    expect(b.sw[0]).toBeLessThanOrEqual(b.ne[0]);
    expect(b.sw[1]).toBeLessThanOrEqual(b.ne[1]);
  });
});
