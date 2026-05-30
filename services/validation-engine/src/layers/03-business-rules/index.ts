/**
 * Layer 3 — Business Rule Validation.
 *
 * Where L1+L2 confirmed the envelope was the right shape and
 * conformed to the canonical schema, L3 applies *operational
 * policy*: does the detection actually make sense given the SOPs the
 * airport operates under?
 *
 * L3 enforces per-detector rules drawn from
 * `data/seed/reference/sop-baseline.json`:
 *
 *   - **FOD on active runway → severity must be `critical`** (and so
 *     on for each `location_category`). A detector that reports a
 *     low-severity FOD on the active runway is either wrong about
 *     the location or wrong about the severity — either way the
 *     operator UI shouldn't surface it as written.
 *   - **FOD object dimension ≥ 2cm.** Smaller is detector noise.
 *   - **Crack width → severity band.** A 30mm crack reported as
 *     `medium` violates the SOP severity band table.
 *   - **Snowbank height ≤ 240cm + setback above the minimum.**
 *     Anything beyond those is a hazard violation, not a routine
 *     callout.
 *   - **Wildlife high-risk class → severity ≥ `high`.** Deer,
 *     coyote, large birds aren't `low`.
 *
 * Rules only fire when the relevant metadata field is present —
 * L3 is not the schema gate (L2 is). A FOD detection without
 * `metadata.object_dimension_cm` passes L3 silently for that rule;
 * L6 (AI output sanity) handles the "metadata too sparse to be
 * useful" case.
 *
 * Sensor frame events skip L3 — they don't carry detection-class
 * payload to evaluate.
 */
import type { ValidationLayerResult, ValidationLayer } from "../types.js";
import type { WireDetectionClass, WireSeverityHint } from "../02-schema/payload-schemas.js";
import {
  DEFAULT_SOP_THRESHOLDS,
  crackSeverityFor,
  severityAtLeast,
  type LocationCategory,
  type SopThresholds,
} from "./sop-thresholds.js";

export interface BusinessRulesConfig {
  /** Override one or more SOP thresholds. Missing fields fall back
   * to `DEFAULT_SOP_THRESHOLDS` so callers don't need to spell out
   * every detector class. */
  thresholds?: DeepPartial<SopThresholds>;
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

const AI_DETECTION_EVENT_TYPE_RE = /^ai\.detection\.[a-z_]+\.emitted$/;

interface RuleFailure {
  code: string;
  message: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
}

export function createBusinessRulesLayer(cfg: BusinessRulesConfig = {}): ValidationLayer {
  const thresholds = mergeThresholds(DEFAULT_SOP_THRESHOLDS, cfg.thresholds);

  return {
    id: "03_business_rules",
    name: "Business Rule Validation",
    async run(ctx) {
      const env = extractEnvelope(ctx.payload);
      if (!env) {
        // L1/L2 should have caught the malformed envelope already.
        // L3 has nothing to evaluate; treat as pass so we don't
        // double-fail.
        return { layer: "03_business_rules", passed: true };
      }
      if (!AI_DETECTION_EVENT_TYPE_RE.test(env.event_type)) {
        // L3 is detection-policy only. Sensor frames + future event
        // families are out of scope.
        return { layer: "03_business_rules", passed: true };
      }
      const detection = env.payload;
      if (!detection) return passing();

      const failures: RuleFailure[] = [];
      switch (detection.detection_class) {
        case "fod":
          checkFod(detection, thresholds, failures);
          break;
        case "crack":
          checkCrack(detection, thresholds, failures);
          break;
        case "snowbank":
          checkSnowbank(detection, thresholds, failures);
          break;
        case "wildlife":
          checkWildlife(detection, thresholds, failures);
          break;
        case "anomaly":
          // Anomaly detections route to HITL (L8); no SOP-driven L3
          // rules apply.
          break;
      }

      return failures.length === 0
        ? passing()
        : {
            layer: "03_business_rules",
            passed: false,
            error_code: failures[0]!.code,
            error_message: failures[0]!.message,
            details: { failures },
          };
    },
  };
}

export const businessRulesLayer: ValidationLayer = createBusinessRulesLayer();

function passing(): ValidationLayerResult {
  return { layer: "03_business_rules", passed: true };
}

// ---- per-class rule implementations ---------------------------------

interface DetectionPayload {
  detection_class: WireDetectionClass;
  severity_hint: WireSeverityHint;
  metadata?: Record<string, unknown>;
}

function checkFod(d: DetectionPayload, sop: SopThresholds, out: RuleFailure[]): void {
  const meta = d.metadata ?? {};
  const dim = numberOr(meta.object_dimension_cm);
  if (dim !== undefined && dim < sop.fod.minObjectDimensionCm) {
    out.push({
      code: "FOD_BELOW_MIN_DIMENSION",
      message: `FOD object_dimension_cm ${dim} is below SOP minimum ${sop.fod.minObjectDimensionCm}`,
      field: "payload.metadata.object_dimension_cm",
      actual: dim,
      expected: `>= ${sop.fod.minObjectDimensionCm}`,
    });
  }
  const loc = stringOr(meta.location_category);
  if (loc !== undefined && isLocationCategory(loc)) {
    const required = sop.fod.locationSeverity[loc];
    if (d.severity_hint !== required) {
      out.push({
        code: "FOD_LOCATION_SEVERITY_MISMATCH",
        message: `FOD on ${loc} must be severity ${required}, got ${d.severity_hint}`,
        field: "payload.severity_hint",
        actual: d.severity_hint,
        expected: required,
      });
    }
  }
}

function checkCrack(d: DetectionPayload, sop: SopThresholds, out: RuleFailure[]): void {
  const meta = d.metadata ?? {};
  const width = numberOr(meta.crack_width_mm);
  if (width === undefined) return;
  const expected = crackSeverityFor(width, sop.crack.severityBandsMm);
  if (d.severity_hint !== expected) {
    out.push({
      code: "CRACK_SEVERITY_BAND_MISMATCH",
      message: `crack ${width}mm requires severity ${expected}, got ${d.severity_hint}`,
      field: "payload.severity_hint",
      actual: d.severity_hint,
      expected,
    });
  }
}

function checkSnowbank(d: DetectionPayload, sop: SopThresholds, out: RuleFailure[]): void {
  const meta = d.metadata ?? {};
  const height = numberOr(meta.snowbank_height_cm);
  if (height !== undefined && height > sop.snowbank.maxHeightCm) {
    out.push({
      code: "SNOWBANK_HEIGHT_OVER_MAX",
      message: `snowbank height ${height}cm exceeds SOP max ${sop.snowbank.maxHeightCm}cm`,
      field: "payload.metadata.snowbank_height_cm",
      actual: height,
      expected: `<= ${sop.snowbank.maxHeightCm}`,
    });
  }
  const setback = numberOr(meta.setback_m);
  const surface = stringOr(meta.surface_kind);
  if (setback !== undefined && surface !== undefined) {
    const minSetback =
      surface === "runway" ? sop.snowbank.runwaySetbackMinM : sop.snowbank.taxiwaySetbackMinM;
    if (setback < minSetback) {
      out.push({
        code: "SNOWBANK_SETBACK_BELOW_MIN",
        message: `snowbank ${setback}m setback below ${surface} SOP min ${minSetback}m`,
        field: "payload.metadata.setback_m",
        actual: setback,
        expected: `>= ${minSetback}`,
      });
    }
  }
}

function checkWildlife(d: DetectionPayload, sop: SopThresholds, out: RuleFailure[]): void {
  const meta = d.metadata ?? {};
  const species = stringOr(meta.species);
  if (species === undefined) return;
  if (!sop.wildlife.highRiskClasses.includes(species)) return;
  if (!severityAtLeast(d.severity_hint, "high")) {
    out.push({
      code: "WILDLIFE_HIGH_RISK_SEVERITY_TOO_LOW",
      message: `wildlife species "${species}" is high-risk; severity must be at least "high", got ${d.severity_hint}`,
      field: "payload.severity_hint",
      actual: d.severity_hint,
      expected: ">= high",
    });
  }
}

// ---- helpers --------------------------------------------------------

interface ExtractedEnvelope {
  event_type: string;
  payload?: DetectionPayload;
}

function extractEnvelope(input: unknown): ExtractedEnvelope | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const env = input as Record<string, unknown>;
  if (typeof env.event_type !== "string") return undefined;
  const detection = extractDetection(env.payload);
  return {
    event_type: env.event_type,
    ...(detection ? { payload: detection } : {}),
  };
}

function extractDetection(raw: unknown): DetectionPayload | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.detection_class !== "string") return undefined;
  if (typeof p.severity_hint !== "string") return undefined;
  return {
    detection_class: p.detection_class as WireDetectionClass,
    severity_hint: p.severity_hint as WireSeverityHint,
    ...(isRecord(p.metadata) ? { metadata: p.metadata as Record<string, unknown> } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numberOr(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function stringOr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isLocationCategory(s: string): s is LocationCategory {
  return s === "runway_active" || s === "runway_inactive" || s === "taxiway" || s === "apron";
}

function mergeThresholds(
  base: SopThresholds,
  override?: DeepPartial<SopThresholds>,
): SopThresholds {
  if (!override) return base;
  return {
    fod: {
      ...base.fod,
      ...(override.fod ?? {}),
      locationSeverity: {
        ...base.fod.locationSeverity,
        ...(override.fod?.locationSeverity ?? {}),
      },
    },
    snowbank: { ...base.snowbank, ...(override.snowbank ?? {}) },
    crack: {
      ...base.crack,
      ...(override.crack ?? {}),
      severityBandsMm: {
        ...base.crack.severityBandsMm,
        ...(override.crack?.severityBandsMm ?? {}),
      },
    },
    wildlife: {
      ...base.wildlife,
      ...(override.wildlife ?? {}),
      highRiskClasses: override.wildlife?.highRiskClasses
        ? [...(override.wildlife.highRiskClasses as string[])]
        : base.wildlife.highRiskClasses,
    },
  };
}
