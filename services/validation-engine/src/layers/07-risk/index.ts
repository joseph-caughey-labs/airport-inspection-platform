/**
 * Layer 7 — Risk & Exception Scoring.
 *
 * L7 doesn't *reject* the way L1–L6 do. It computes a transparent,
 * named-factor risk score over the (envelope, payload, previous
 * results) tuple and surfaces it on `details.risk` so:
 *
 *   - L8 (HITL routing, T-411) uses `routes_to_hitl` as the gate
 *     to drop the incident into the reviewer queue.
 *   - The audit trail (T-412) records the score + factor breakdown
 *     so postmortems can answer "why was this routed to HITL?"
 *
 * **One exception path**: when the score crosses the `exceptionScoreThreshold`
 * (default 0.95) the layer fails with `RISK_EXCEPTION_THRESHOLD`. This is
 * for the truly anomalous case — every named factor maxed simultaneously
 * — and is rare by construction. Operators see it as a hard reject and
 * a top-of-queue review.
 *
 * Factor breakdown (weights sum to 1.0):
 *   - confidence_gap      0.30  ▶ `1 - confidence` (higher = riskier)
 *   - freshness           0.20  ▶ age vs `freshnessSpanMs`
 *   - severity_weight     0.30  ▶ critical=1, info=0
 *   - prior_failure_density 0.20 ▶ failed previous layers / 5
 *
 * Anyone reading the score can also read the factor map and see
 * what tipped it; this beats a black-box gradient-boost score for
 * the operator-trust property the platform needs.
 */
import type { ValidationLayer } from "../types.js";
import type { WireSeverityHint } from "../02-schema/payload-schemas.js";

export interface RiskScoringConfig {
  /** Detection score must be at or above this to route to HITL. */
  hitlScoreThreshold?: number;
  /** Score at/above this fails the layer with RISK_EXCEPTION_THRESHOLD. */
  exceptionScoreThreshold?: number;
  /** Window over which freshness factor saturates (1.0). Default 1h. */
  freshnessSpanMs?: number;
  /** Test seam — default `new Date()`. */
  now?: () => Date;
}

const DEFAULT_HITL_SCORE_THRESHOLD = 0.6;
const DEFAULT_EXCEPTION_SCORE_THRESHOLD = 0.95;
const DEFAULT_FRESHNESS_SPAN_MS = 60 * 60 * 1000;

const AI_DETECTION_EVENT_TYPE_RE = /^ai\.detection\.[a-z_]+\.emitted$/;

const SEVERITY_WEIGHT: Record<WireSeverityHint, number> = {
  critical: 1,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
  info: 0,
};

const FACTOR_WEIGHTS = {
  confidence_gap: 0.3,
  freshness: 0.2,
  severity_weight: 0.3,
  prior_failure_density: 0.2,
} as const;

export interface RiskFactors {
  confidence_gap: number;
  freshness: number;
  severity_weight: number;
  prior_failure_density: number;
}

export interface RiskReport {
  score: number;
  factors: RiskFactors;
  routes_to_hitl: boolean;
}

export function createRiskScoringLayer(cfg: RiskScoringConfig = {}): ValidationLayer {
  const hitlThreshold = cfg.hitlScoreThreshold ?? DEFAULT_HITL_SCORE_THRESHOLD;
  const exceptionThreshold = cfg.exceptionScoreThreshold ?? DEFAULT_EXCEPTION_SCORE_THRESHOLD;
  const freshnessSpan = cfg.freshnessSpanMs ?? DEFAULT_FRESHNESS_SPAN_MS;
  const now = cfg.now ?? (() => new Date());

  return {
    id: "07_risk",
    name: "Risk & Exception Scoring",
    async run(ctx) {
      const env = extractEnvelope(ctx.payload);
      if (!env || !AI_DETECTION_EVENT_TYPE_RE.test(env.event_type) || !env.payload) {
        // Sensor frames + malformed input pass L7 — no risk model
        // applies. L1/L2 caught the shape issues already.
        return { layer: "07_risk", passed: true };
      }

      const factors = computeFactors(
        env,
        ctx.previous_results.length,
        ctx.previous_results.filter((r) => !r.passed).length,
        now(),
        freshnessSpan,
      );
      const score = combine(factors);
      const routesToHitl = score >= hitlThreshold;
      const report: RiskReport = { score, factors, routes_to_hitl: routesToHitl };

      if (score >= exceptionThreshold) {
        return {
          layer: "07_risk",
          passed: false,
          error_code: "RISK_EXCEPTION_THRESHOLD",
          error_message: `risk score ${score.toFixed(3)} >= exception threshold ${exceptionThreshold}`,
          details: { risk: report },
        };
      }

      return {
        layer: "07_risk",
        passed: true,
        details: { risk: report },
      };
    },
  };
}

export const riskScoringLayer: ValidationLayer = createRiskScoringLayer();

function combine(f: RiskFactors): number {
  const raw =
    f.confidence_gap * FACTOR_WEIGHTS.confidence_gap +
    f.freshness * FACTOR_WEIGHTS.freshness +
    f.severity_weight * FACTOR_WEIGHTS.severity_weight +
    f.prior_failure_density * FACTOR_WEIGHTS.prior_failure_density;
  // Clamp defensively; in practice the inputs are each [0,1].
  return Math.max(0, Math.min(1, raw));
}

interface ExtractedEnvelope {
  event_type: string;
  timestamp?: string;
  payload?: ExtractedPayload;
}

interface ExtractedPayload {
  confidence: number;
  severity_hint?: WireSeverityHint;
  captured_at?: string;
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
  if (typeof p.severity_hint === "string" && p.severity_hint in SEVERITY_WEIGHT) {
    out.severity_hint = p.severity_hint as WireSeverityHint;
  }
  if (typeof p.captured_at === "string") out.captured_at = p.captured_at;
  return out;
}

function computeFactors(
  env: ExtractedEnvelope,
  totalPrior: number,
  priorFailures: number,
  now: Date,
  freshnessSpanMs: number,
): RiskFactors {
  const payload = env.payload!;
  const confidenceGap = clamp01(1 - payload.confidence);
  const freshness = computeFreshness(payload.captured_at ?? env.timestamp, now, freshnessSpanMs);
  const severityWeight = payload.severity_hint ? SEVERITY_WEIGHT[payload.severity_hint] : 0;
  // 5+ prior failures = saturated; per-layer densities above match
  // the demo's max layers run before L7.
  const priorFailureDensity = totalPrior === 0 ? 0 : clamp01(priorFailures / 5);
  return {
    confidence_gap: confidenceGap,
    freshness,
    severity_weight: severityWeight,
    prior_failure_density: priorFailureDensity,
  };
}

function computeFreshness(timestamp: string | undefined, now: Date, spanMs: number): number {
  if (!timestamp) return 0;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return 0;
  const ageMs = Math.max(0, now.getTime() - t);
  return clamp01(ageMs / spanMs);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
