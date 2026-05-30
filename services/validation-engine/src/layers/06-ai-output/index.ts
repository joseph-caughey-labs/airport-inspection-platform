/**
 * Layer 6 — AI Output Sanity.
 *
 * Where L2 validated the schema shape of the AI detection payload,
 * L6 asks operational sanity questions about the model's output:
 *
 *   1. **Bbox stays inside the image.** A bbox that extends past
 *      the frame edge (`x + w > 1` or `y + h > 1`) is a detector
 *      bug — the coordinate-system contract is normalized [0,1].
 *
 *   2. **Confidence clears the operational floor.** A detection
 *      below `minConfidence` should never have been published by
 *      the AI runtime (calibration drops it per
 *      `risk-scoring.md`), so seeing it here means a bypass.
 *
 *   3. **Evidence linkage is real.** `detection_id`, `frame_id`,
 *      `sensor_id` must all be non-blank distinct values. L2 already
 *      ensured these are non-empty strings; L6 verifies they're not
 *      duplicate sentinels like `"unknown"` or all-equal — patterns
 *      we've seen out of failing detectors during development.
 *
 *   4. **captured_at sits inside the envelope timestamp window.**
 *      The frame can't have been captured after the envelope was
 *      emitted, and the gap can't exceed `maxCaptureSkewMs`. A
 *      large gap (e.g., 1 hour) on a live detection points at a
 *      mis-stamped clock or stale frame leakage.
 *
 * Only AI detection events are evaluated. Sensor frames pass L6
 * unconditionally — there's no model output to sanity-check.
 */
import type { ValidationLayer } from "../types.js";

export interface AiOutputSanityConfig {
  /** Operational minimum confidence — anything below shouldn't have
   * survived the AI publisher's calibration. Default 0.40 mirrors
   * the FOD detector's `min_publish_threshold` from
   * `docs/validation/risk-scoring.md`. */
  minConfidence?: number;
  /** Max allowed positive gap (ms) between `envelope.timestamp` and
   * `payload.captured_at`. Default 5 minutes. */
  maxCaptureSkewMs?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.4;
const DEFAULT_MAX_CAPTURE_SKEW_MS = 5 * 60 * 1000;

const AI_DETECTION_EVENT_TYPE_RE = /^ai\.detection\.[a-z_]+\.emitted$/;

interface SanityFailure {
  code: string;
  message: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
}

export function createAiOutputSanityLayer(cfg: AiOutputSanityConfig = {}): ValidationLayer {
  const minConfidence = cfg.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxCaptureSkewMs = cfg.maxCaptureSkewMs ?? DEFAULT_MAX_CAPTURE_SKEW_MS;

  return {
    id: "06_ai_output",
    name: "AI Output Sanity",
    async run(ctx) {
      const env = extractEnvelope(ctx.payload);
      if (!env) return { layer: "06_ai_output", passed: true };
      if (!AI_DETECTION_EVENT_TYPE_RE.test(env.event_type)) {
        return { layer: "06_ai_output", passed: true };
      }
      if (!env.payload) return { layer: "06_ai_output", passed: true };

      const failures: SanityFailure[] = [];

      // 1. Bbox extent inside image.
      const bbox = env.payload.bbox;
      if (bbox) {
        if (bbox.x + bbox.w > 1.0001) {
          failures.push({
            code: "BBOX_EXTENT_OUT_OF_IMAGE",
            message: `bbox extends past right edge: x+w=${bbox.x + bbox.w}`,
            field: "payload.bbox",
          });
        }
        if (bbox.y + bbox.h > 1.0001) {
          failures.push({
            code: "BBOX_EXTENT_OUT_OF_IMAGE",
            message: `bbox extends past bottom edge: y+h=${bbox.y + bbox.h}`,
            field: "payload.bbox",
          });
        }
      }

      // 2. Confidence ≥ minConfidence.
      if (env.payload.confidence < minConfidence) {
        failures.push({
          code: "CONFIDENCE_BELOW_MIN",
          message: `confidence ${env.payload.confidence} is below operational floor ${minConfidence}`,
          field: "payload.confidence",
          actual: env.payload.confidence,
          expected: `>= ${minConfidence}`,
        });
      }

      // 3. Evidence linkage.
      const { detection_id, frame_id, sensor_id } = env.payload;
      if (isBlankSentinel(detection_id)) {
        failures.push({
          code: "EVIDENCE_LINKAGE_BLANK",
          message: `detection_id "${detection_id}" looks like a sentinel`,
          field: "payload.detection_id",
        });
      }
      if (detection_id === frame_id && detection_id !== undefined) {
        failures.push({
          code: "EVIDENCE_LINKAGE_DUPLICATE",
          message: "detection_id and frame_id are identical — evidence linkage is unreliable",
        });
      }
      if (sensor_id !== undefined && (detection_id === sensor_id || frame_id === sensor_id)) {
        failures.push({
          code: "EVIDENCE_LINKAGE_DUPLICATE",
          message:
            "sensor_id collides with detection_id or frame_id — evidence linkage is unreliable",
        });
      }

      // 4. captured_at vs envelope.timestamp.
      if (env.timestamp && env.payload.captured_at) {
        const t = Date.parse(env.timestamp);
        const c = Date.parse(env.payload.captured_at);
        if (!Number.isNaN(t) && !Number.isNaN(c)) {
          if (c > t) {
            failures.push({
              code: "CAPTURED_AT_AFTER_ENVELOPE",
              message: `payload.captured_at (${env.payload.captured_at}) is after envelope.timestamp (${env.timestamp})`,
              field: "payload.captured_at",
            });
          } else if (t - c > maxCaptureSkewMs) {
            failures.push({
              code: "CAPTURE_SKEW_EXCEEDS_MAX",
              message: `frame captured ${Math.round((t - c) / 1000)}s before envelope; max allowed ${Math.round(maxCaptureSkewMs / 1000)}s`,
              field: "payload.captured_at",
            });
          }
        }
      }

      if (failures.length === 0) {
        return { layer: "06_ai_output", passed: true };
      }
      const primary = failures[0]!;
      return {
        layer: "06_ai_output",
        passed: false,
        error_code: primary.code,
        error_message: primary.message,
        details: { failures },
      };
    },
  };
}

export const aiOutputLayer: ValidationLayer = createAiOutputSanityLayer();

interface ExtractedEnvelope {
  event_type: string;
  timestamp?: string;
  payload?: ExtractedPayload;
}

interface ExtractedPayload {
  detection_id?: string;
  sensor_id?: string;
  frame_id?: string;
  confidence: number;
  captured_at?: string;
  bbox?: { x: number; y: number; w: number; h: number };
}

function extractEnvelope(input: unknown): ExtractedEnvelope | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const env = input as Record<string, unknown>;
  if (typeof env.event_type !== "string") return undefined;
  const out: ExtractedEnvelope = { event_type: env.event_type };
  if (typeof env.timestamp === "string") out.timestamp = env.timestamp;
  const payload = extractPayload(env.payload);
  if (payload) out.payload = payload;
  return out;
}

function extractPayload(raw: unknown): ExtractedPayload | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.confidence !== "number") return undefined;
  const out: ExtractedPayload = { confidence: p.confidence };
  if (typeof p.detection_id === "string") out.detection_id = p.detection_id;
  if (typeof p.sensor_id === "string") out.sensor_id = p.sensor_id;
  if (typeof p.frame_id === "string") out.frame_id = p.frame_id;
  if (typeof p.captured_at === "string") out.captured_at = p.captured_at;
  const bbox = extractBbox(p.bbox);
  if (bbox) out.bbox = bbox;
  return out;
}

function extractBbox(raw: unknown): { x: number; y: number; w: number; h: number } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  if (
    typeof b.x !== "number" ||
    typeof b.y !== "number" ||
    typeof b.w !== "number" ||
    typeof b.h !== "number"
  ) {
    return undefined;
  }
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

const BLANK_SENTINELS = new Set(["unknown", "n/a", "na", "none", "null", "-"]);

function isBlankSentinel(s: string | undefined): boolean {
  if (s === undefined) return false;
  return BLANK_SENTINELS.has(s.trim().toLowerCase());
}
