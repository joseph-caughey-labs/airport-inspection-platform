/**
 * Layer 1 — Input Validation.
 *
 * The shape gate. Before any of the deeper layers (schema, business
 * rules, AI sanity, ...) get to look at a payload, L1 confirms the
 * basics:
 *
 *   1. The envelope is an object with the required fields present
 *      (`event_id`, `event_type`, `schema_version`, `source`,
 *      `timestamp`, `payload`).
 *   2. `event_id` is a syntactic UUID.
 *   3. `event_type` is a non-empty string and (for the AI-detection
 *      path that drives most submissions) looks like
 *      `ai.detection.<class>.emitted`.
 *   4. `timestamp` parses as ISO-8601 and falls inside a reasonable
 *      window around now — by default `[now - 24h, now + 5min]`.
 *      Skewed clocks at the edge can drift slightly into the future;
 *      anything beyond that is wrong, not late.
 *   5. `payload` exists and is an object.
 *   6. If the payload carries a `geo`, its coordinates are inside the
 *      physically valid range.
 *
 * Anything beyond these — enum values for `detection_class`,
 * bounding-box bounds, severity-hint enum, etc. — belongs to
 * L2 / L6, not L1. L1 is intentionally cheap and surface-level so
 * the validation engine can short-circuit on garbage without
 * touching the slower layers.
 *
 * Layer is exported as a *factory* (`createInputValidationLayer`)
 * because it needs an injectable clock (for deterministic tests of
 * the timestamp-window rule) + configurable skew bounds.
 */
import type { ValidationLayer } from "../types.js";

export interface InputValidationConfig {
  /** Test seam: replace `new Date()` for deterministic window tests. */
  now?: () => Date;
  /**
   * How far INTO the future a timestamp may sit before L1 rejects.
   * Default 5 minutes — accommodates small NTP drift across services
   * without letting through "this happens in 3 hours" garbage.
   */
  maxFutureSkewMs?: number;
  /**
   * How far INTO the past a timestamp may sit. Default 24 hours —
   * older than that is almost certainly replay traffic from a fixture
   * the operator never asked us to look at, and the replay queue
   * (T-415) is the right path for late events.
   */
  maxPastSkewMs?: number;
}

const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PAST_SKEW_MS = 24 * 60 * 60 * 1_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AI_DETECTION_EVENT_TYPE_RE = /^ai\.detection\.[a-z_]+\.emitted$/;

export function createInputValidationLayer(cfg: InputValidationConfig = {}): ValidationLayer {
  const now = cfg.now ?? (() => new Date());
  const maxFuture = cfg.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  const maxPast = cfg.maxPastSkewMs ?? DEFAULT_MAX_PAST_SKEW_MS;

  return {
    id: "01_input",
    name: "Input Validation",
    async run(ctx) {
      const failures = collectFailures(ctx.payload, { now: now(), maxFuture, maxPast });
      if (failures.length === 0) {
        return { layer: "01_input", passed: true };
      }
      const primary = failures[0]!;
      return {
        layer: "01_input",
        passed: false,
        error_code: primary.code,
        error_message: primary.message,
        details: { failures },
      };
    },
  };
}

/**
 * Back-compat export so existing call sites that imported the
 * constant keep compiling — uses defaults (`new Date()` clock,
 * 5min/24h skew). The orchestrator wires this in `ORDERED_LAYERS`.
 */
export const inputValidationLayer: ValidationLayer = createInputValidationLayer();

interface InputFailure {
  code: string;
  message: string;
  field?: string;
  value?: unknown;
}

interface CheckContext {
  now: Date;
  maxFuture: number;
  maxPast: number;
}

function collectFailures(payload: unknown, c: CheckContext): InputFailure[] {
  const out: InputFailure[] = [];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    out.push({
      code: "ENVELOPE_NOT_OBJECT",
      message: "submission payload must be a non-array object",
    });
    return out;
  }
  const env = payload as Record<string, unknown>;

  const REQUIRED = ["event_id", "event_type", "schema_version", "source", "timestamp", "payload"];
  for (const field of REQUIRED) {
    if (!(field in env)) {
      out.push({ code: "MISSING_FIELD", message: `required field "${field}" is missing`, field });
    }
  }
  // If any required field is missing we still continue with the
  // checks the other fields support — operators want to see every
  // L1 issue in one pass, not one fix-and-resubmit cycle per field.

  if (typeof env.event_id === "string" && !UUID_RE.test(env.event_id)) {
    out.push({
      code: "INVALID_UUID",
      message: "event_id must be a UUID",
      field: "event_id",
      value: env.event_id,
    });
  }

  if (typeof env.event_type === "string") {
    if (env.event_type.length === 0) {
      out.push({
        code: "EMPTY_EVENT_TYPE",
        message: "event_type must be non-empty",
        field: "event_type",
      });
    } else if (
      env.event_type.startsWith("ai.detection.") &&
      !AI_DETECTION_EVENT_TYPE_RE.test(env.event_type)
    ) {
      // We only enforce the AI-detection pattern when the caller
      // declares this *is* an AI detection. Other event_type values
      // (e.g. "sensor.frame.captured") are L2's job to validate
      // against their concrete schema.
      out.push({
        code: "INVALID_AI_DETECTION_EVENT_TYPE",
        message: 'event_type must match "ai.detection.<class>.emitted"',
        field: "event_type",
        value: env.event_type,
      });
    }
  }

  if (typeof env.timestamp === "string") {
    const parsed = Date.parse(env.timestamp);
    if (Number.isNaN(parsed)) {
      out.push({
        code: "INVALID_TIMESTAMP",
        message: "timestamp must be ISO-8601",
        field: "timestamp",
        value: env.timestamp,
      });
    } else {
      const driftMs = parsed - c.now.getTime();
      if (driftMs > c.maxFuture) {
        out.push({
          code: "TIMESTAMP_IN_FUTURE",
          message: `timestamp is ${Math.round(driftMs / 1000)}s in the future (max ${Math.round(
            c.maxFuture / 1000,
          )}s)`,
          field: "timestamp",
          value: env.timestamp,
        });
      } else if (-driftMs > c.maxPast) {
        out.push({
          code: "TIMESTAMP_TOO_OLD",
          message: `timestamp is ${Math.round(-driftMs / 1000)}s old (max ${Math.round(
            c.maxPast / 1000,
          )}s)`,
          field: "timestamp",
          value: env.timestamp,
        });
      }
    }
  }

  if (env.payload !== undefined) {
    if (typeof env.payload !== "object" || env.payload === null || Array.isArray(env.payload)) {
      out.push({
        code: "PAYLOAD_NOT_OBJECT",
        message: "payload must be a non-array object",
        field: "payload",
      });
    } else {
      checkGeo(env.payload as Record<string, unknown>, out);
    }
  }

  return out;
}

function checkGeo(payload: Record<string, unknown>, out: InputFailure[]): void {
  const geo = payload.geo;
  if (geo === undefined || geo === null) return;
  if (typeof geo !== "object" || Array.isArray(geo)) {
    out.push({
      code: "GEO_NOT_OBJECT",
      message: "payload.geo must be an object when present",
      field: "payload.geo",
    });
    return;
  }
  const g = geo as Record<string, unknown>;
  if (typeof g.lat === "number" && (g.lat < -90 || g.lat > 90)) {
    out.push({
      code: "GEO_LAT_OUT_OF_RANGE",
      message: "payload.geo.lat must be in [-90, 90]",
      field: "payload.geo.lat",
      value: g.lat,
    });
  }
  if (typeof g.lng === "number" && (g.lng < -180 || g.lng > 180)) {
    out.push({
      code: "GEO_LNG_OUT_OF_RANGE",
      message: "payload.geo.lng must be in [-180, 180]",
      field: "payload.geo.lng",
      value: g.lng,
    });
  }
}
