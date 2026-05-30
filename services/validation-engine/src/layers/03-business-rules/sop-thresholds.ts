/**
 * SOP thresholds that L3 enforces against AI detections.
 *
 * Values mirror `data/seed/reference/sop-baseline.json`. We keep
 * defaults inline rather than reading the JSON at runtime so:
 *   - the layer stays pure (no FS I/O on the hot path)
 *   - tests don't need a fixture file mounted
 *   - a SOP-file change in `data/seed/reference/` requires a
 *     conscious update here, surfacing drift in code review
 *
 * If the SOPs ever live behind reference-data (T-306), the loader
 * here is the seam where that fetch lands.
 */
import type { WireDetectionClass, WireSeverityHint } from "../02-schema/payload-schemas.js";

/** Severity order, low → high. Used for "at least" comparisons. */
export const SEVERITY_ORDER: readonly WireSeverityHint[] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];

export type LocationCategory = "runway_active" | "runway_inactive" | "taxiway" | "apron";

export interface SopThresholds {
  fod: {
    /** Minimum reportable object dimension (cm). Below this is
     * fixture noise, not a real FOD callout. */
    minObjectDimensionCm: number;
    /** Required severity per location category. A FOD on an active
     * runway MUST be `critical`; one on the apron MUST be `low`. */
    locationSeverity: Record<LocationCategory, WireSeverityHint>;
  };
  snowbank: {
    maxHeightCm: number;
    runwaySetbackMinM: number;
    taxiwaySetbackMinM: number;
  };
  crack: {
    /** Severity bands keyed by upper width bound (mm). A 7mm crack
     * falls in `medium` (>6 ≤12); a 26mm crack in `critical` (>25). */
    severityBandsMm: Record<Exclude<WireSeverityHint, "info">, number>;
  };
  wildlife: {
    /** Species that must be flagged with at least `high` severity. */
    highRiskClasses: readonly string[];
  };
}

export const DEFAULT_SOP_THRESHOLDS: SopThresholds = {
  fod: {
    minObjectDimensionCm: 2,
    locationSeverity: {
      runway_active: "critical",
      runway_inactive: "high",
      taxiway: "medium",
      apron: "low",
    },
  },
  snowbank: {
    maxHeightCm: 240,
    runwaySetbackMinM: 6,
    taxiwaySetbackMinM: 3,
  },
  crack: {
    severityBandsMm: { low: 6, medium: 12, high: 25, critical: 50 },
  },
  wildlife: {
    highRiskClasses: ["deer", "coyote", "large_bird"],
  },
};

/**
 * Returns true if `actual` is at least `required` in the severity
 * order (`critical` ≥ `high` ≥ `medium` ≥ `low` ≥ `info`).
 */
export function severityAtLeast(actual: WireSeverityHint, required: WireSeverityHint): boolean {
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(required);
}

/** Lookup the expected severity for a measured crack width. */
export function crackSeverityFor(
  widthMm: number,
  bands: SopThresholds["crack"]["severityBandsMm"],
): WireSeverityHint {
  if (widthMm <= bands.low) return "low";
  if (widthMm <= bands.medium) return "medium";
  if (widthMm <= bands.high) return "high";
  return "critical";
}

/** Re-export so callers can refine `detection_class` without
 * re-importing the schemas module. */
export type { WireDetectionClass, WireSeverityHint };
