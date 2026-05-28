import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import type { Airport, Runway, Sensor } from "~/types/airport";
import { computeAirportBounds, runwaysToGeoJSON, sensorsToGeoJSON } from "~/utils/map-geo";

export interface AirportMapHandle {
  /** Tears down map + listeners. Idempotent. */
  destroy(): void;
  /** Triggers a brief pulse animation on the marker for `sensorId`. */
  pulseSensor(sensorId: string): void;
  /** Re-centers/fits the camera to the airfield extent. */
  resetCamera(): void;
}

export interface MountOptions {
  container: HTMLElement;
  airport: Airport;
  runways: Runway[];
  sensors: Sensor[];
  styleUrl?: string;
}

const RUNWAY_SOURCE = "aip-runways";
const RUNWAY_CASING_LAYER = "aip-runways-casing";
const RUNWAY_LINE_LAYER = "aip-runways-line";
const SENSOR_SOURCE = "aip-sensors";
const SENSOR_LAYER = "aip-sensors-circle";
const SENSOR_PULSE_LAYER = "aip-sensors-pulse";

/** Width-by-zoom expression so runways thicken as you zoom in. */
const RUNWAY_WIDTH_EXPR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  10,
  1.5,
  13,
  3,
  15,
  6,
  17,
  10,
];

/**
 * Mounts a MapLibre map into `container` and renders the airport's
 * runways + sensors on top of the dark Carto basemap.
 *
 * Lives in a composable rather than directly in the .vue component so
 * the imperative MapLibre lifecycle (add/removeSource, listeners,
 * destroy on unmount) stays out of the Vue reactivity loop. The
 * returned handle is what the component holds via `shallowRef`.
 *
 * No WebSocket integration here — T-213 will call `pulseSensor()`
 * from the WS store when a `sensor.frame.captured` lands.
 */
export function mountAirportMap(opts: MountOptions): AirportMapHandle {
  const bounds = computeAirportBounds(opts.airport, opts.runways);

  const map: MapLibreMap = new maplibregl.Map({
    container: opts.container,
    style: (opts.styleUrl ?? "/map/dark-style.json") as string | StyleSpecification,
    center: [opts.airport.lng, opts.airport.lat],
    zoom: opts.airport.default_zoom,
    attributionControl: { compact: true },
    cooperativeGestures: false,
  });

  const fitCameraToAirfield = (): void => {
    map.fitBounds([bounds.sw, bounds.ne], { padding: 60, duration: 0, maxZoom: 15 });
  };

  let destroyed = false;

  map.on("load", () => {
    if (destroyed) return;

    map.addSource(RUNWAY_SOURCE, {
      type: "geojson",
      data: runwaysToGeoJSON(opts.runways),
    });

    // Casing under the line gives it a subtle glow that reads
    // well on the dark basemap without competing with sensor markers.
    map.addLayer({
      id: RUNWAY_CASING_LAYER,
      type: "line",
      source: RUNWAY_SOURCE,
      paint: {
        "line-color": "#22d3ee",
        "line-opacity": 0.25,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 13, 7, 15, 12, 17, 18],
        "line-blur": 2,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    map.addLayer({
      id: RUNWAY_LINE_LAYER,
      type: "line",
      source: RUNWAY_SOURCE,
      paint: {
        "line-color": [
          "match",
          ["get", "status"],
          "open",
          "#e6ebf1",
          "restricted",
          "#d97706",
          "closed",
          "#dc2626",
          "#e6ebf1",
        ],
        "line-width": RUNWAY_WIDTH_EXPR,
      },
      layout: { "line-cap": "butt", "line-join": "round" },
    });

    map.addSource(SENSOR_SOURCE, {
      type: "geojson",
      data: sensorsToGeoJSON(opts.sensors),
    });

    // Pulse ring layer — invisible by default, animated on pulseSensor().
    map.addLayer({
      id: SENSOR_PULSE_LAYER,
      type: "circle",
      source: SENSOR_SOURCE,
      paint: {
        "circle-radius": ["case", ["==", ["get", "id"], ["literal", ""]], 0, 0],
        "circle-color": ["get", "color"],
        "circle-opacity": 0,
        "circle-stroke-width": 0,
      },
      filter: ["==", ["get", "id"], "__none__"],
    });

    map.addLayer({
      id: SENSOR_LAYER,
      type: "circle",
      source: SENSOR_SOURCE,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5, 15, 7, 17, 9],
        "circle-color": ["get", "color"],
        "circle-stroke-color": ["get", "stroke"],
        "circle-stroke-width": 1.5,
        "circle-opacity": 0.92,
      },
    });

    fitCameraToAirfield();
  });

  // Active pulse timers, keyed by sensor id, so a flurry of frames
  // on one sensor doesn't queue overlapping animations.
  const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const pulseSensor = (sensorId: string): void => {
    if (destroyed || !map.isStyleLoaded()) return;
    if (pulseTimers.has(sensorId)) return;

    // Render the pulse ring on just this sensor.
    map.setFilter(SENSOR_PULSE_LAYER, ["==", ["get", "id"], sensorId]);

    const start = performance.now();
    const duration = 750;
    const tick = (): void => {
      if (destroyed) return;
      const t = Math.min(1, (performance.now() - start) / duration);
      const radius = 8 + 22 * t;
      const opacity = 0.45 * (1 - t);
      map.setPaintProperty(SENSOR_PULSE_LAYER, "circle-radius", radius);
      map.setPaintProperty(SENSOR_PULSE_LAYER, "circle-opacity", opacity);
      if (t < 1) {
        const id = requestAnimationFrame(tick);
        pulseTimers.set(sensorId, id as unknown as ReturnType<typeof setTimeout>);
      } else {
        map.setFilter(SENSOR_PULSE_LAYER, ["==", ["get", "id"], "__none__"]);
        pulseTimers.delete(sensorId);
      }
    };
    pulseTimers.set(sensorId, setTimeout(tick, 0));
  };

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const t of pulseTimers.values()) clearTimeout(t);
      pulseTimers.clear();
      map.remove();
    },
    pulseSensor,
    resetCamera: fitCameraToAirfield,
  };
}
