import type { Airport, Runway, Sensor, SensorStatus, SensorType } from "~/types/airport";

/**
 * Pure (no Vue, no DOM, no MapLibre) helpers for shaping seed data
 * into MapLibre-ready GeoJSON. Kept Vue-free so vitest can hit them
 * directly without the framework wrappers that pnpm strict isolation
 * struggles with (see CLAUDE notes — component tests deferred to
 * Playwright in T-214).
 */

/** Sensor type → display color (kept in sync with tailwind.config.ts). */
export const SENSOR_TYPE_COLOR: Record<SensorType, string> = {
  camera: "#22d3ee", // aip.accent
  lidar: "#a78bfa", // violet-400 — visually distinct from camera
  gps: "#34d399", // emerald-400
  imu: "#fbbf24", // amber-400
  weather: "#60a5fa", // blue-400
  perimeter: "#f472b6", // pink-400
};

/** Sensor status → marker stroke color. Mirrors severity scale for offline. */
export const SENSOR_STATUS_STROKE: Record<SensorStatus, string> = {
  online: "#16a34a", // conn.ok
  degraded: "#d97706", // severity.medium
  offline: "#dc2626", // severity.critical
};

export interface RunwayLineFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: {
    id: string;
    designator: string;
    paired_designator: string;
    surface: string;
    status: Runway["status"];
    width_m: number;
    length_m: number;
  };
}

export interface SensorPointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    sensor_type: SensorType;
    status: SensorStatus;
    color: string;
    stroke: string;
  };
}

export interface FeatureCollection<T> {
  type: "FeatureCollection";
  features: T[];
}

export function runwaysToGeoJSON(runways: Runway[]): FeatureCollection<RunwayLineFeature> {
  return {
    type: "FeatureCollection",
    features: runways.map((r) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [r.lng_start, r.lat_start],
          [r.lng_end, r.lat_end],
        ],
      },
      properties: {
        id: r.id,
        designator: r.designator,
        paired_designator: r.paired_designator,
        surface: r.surface,
        status: r.status,
        width_m: r.width_m,
        length_m: r.length_m,
      },
    })),
  };
}

export function sensorsToGeoJSON(sensors: Sensor[]): FeatureCollection<SensorPointFeature> {
  return {
    type: "FeatureCollection",
    features: sensors.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      properties: {
        id: s.id,
        sensor_type: s.type,
        status: s.status,
        color: SENSOR_TYPE_COLOR[s.type],
        stroke: SENSOR_STATUS_STROKE[s.status],
      },
    })),
  };
}

/**
 * Computes a LngLatBounds-ready 2D box from an airport + its runways.
 * Falls back to a small box around the airport anchor when there are
 * no runways. Used to fitBounds() on initial map mount so the camera
 * frames the airfield instead of staring at the airport centroid.
 */
export function computeAirportBounds(
  airport: Airport,
  runways: Runway[],
): { sw: [number, number]; ne: [number, number] } {
  if (runways.length === 0) {
    const pad = 0.01;
    return {
      sw: [airport.lng - pad, airport.lat - pad],
      ne: [airport.lng + pad, airport.lat + pad],
    };
  }
  let minLat = airport.lat;
  let maxLat = airport.lat;
  let minLng = airport.lng;
  let maxLng = airport.lng;
  for (const r of runways) {
    minLat = Math.min(minLat, r.lat_start, r.lat_end);
    maxLat = Math.max(maxLat, r.lat_start, r.lat_end);
    minLng = Math.min(minLng, r.lng_start, r.lng_end);
    maxLng = Math.max(maxLng, r.lng_start, r.lng_end);
  }
  return {
    sw: [minLng, minLat],
    ne: [maxLng, maxLat],
  };
}
