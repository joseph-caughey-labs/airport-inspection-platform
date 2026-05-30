/**
 * Layer 8 — Human-in-the-Loop (HITL) Routing.
 *
 * L8 doesn't reject. It reads L7's risk report from
 * `previous_results` and produces a routing decision on
 * `details.hitl`:
 *
 *   - `routed_to_hitl: boolean`
 *   - `priority: "high" | "normal"`
 *   - `reasons: string[]`     ▶ named reasons the gate triggered
 *
 * L10 (certification) reads `routed_to_hitl` and refuses to certify
 * until a reviewer signs off. The reviewer queue + decision API
 * land in the audit-service / notification-service tickets
 * (T-412 / T-413) — L8 is just the gate signal.
 *
 * Inputs the layer considers:
 *
 *   - L7's `routes_to_hitl` (the primary signal)
 *   - Any prior layer that failed: contradictions across the
 *     pipeline route to HITL even if their individual rejection was
 *     a hard fail (the audit trail wants the reviewer's read)
 *   - Detection severity: a `critical` detection routed to HITL gets
 *     `priority=high`, everything else `normal`
 *
 * Like L7 + L9, L8 doesn't apply to non-AI-detection inputs —
 * sensor frames don't go through HITL.
 */
import type { ValidationLayer } from "../types.js";
import type { WireSeverityHint } from "../02-schema/payload-schemas.js";

const AI_DETECTION_EVENT_TYPE_RE = /^ai\.detection\.[a-z_]+\.emitted$/;

const HIGH_PRIORITY_SEVERITIES: ReadonlySet<WireSeverityHint> = new Set(["critical"]);

export interface HitlDecision {
  routed_to_hitl: boolean;
  priority: "high" | "normal";
  reasons: string[];
}

export function createHumanReviewLayer(): ValidationLayer {
  return {
    id: "08_human_review",
    name: "Human-in-the-Loop Review",
    async run(ctx) {
      const env = extractEnvelope(ctx.payload);
      if (!env || !AI_DETECTION_EVENT_TYPE_RE.test(env.event_type)) {
        return { layer: "08_human_review", passed: true };
      }

      const reasons: string[] = [];
      const riskReport = readRiskReport(ctx.previous_results);
      if (riskReport?.routes_to_hitl) {
        reasons.push(`risk_score=${riskReport.score.toFixed(3)} >= hitl_threshold`);
      }

      const priorFailures = ctx.previous_results.filter((r) => !r.passed);
      if (priorFailures.length > 0) {
        reasons.push(`prior_layer_failure=${priorFailures.map((f) => f.layer).join(",")}`);
      }

      const routed = reasons.length > 0;
      const severityHint = env.severity_hint;
      const priority: "high" | "normal" =
        routed && severityHint && HIGH_PRIORITY_SEVERITIES.has(severityHint) ? "high" : "normal";

      const decision: HitlDecision = {
        routed_to_hitl: routed,
        priority,
        reasons,
      };

      return {
        layer: "08_human_review",
        passed: true,
        details: { hitl: decision },
      };
    },
  };
}

export const humanReviewLayer: ValidationLayer = createHumanReviewLayer();

interface ExtractedEnvelope {
  event_type: string;
  severity_hint?: WireSeverityHint;
}

function extractEnvelope(input: unknown): ExtractedEnvelope | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const env = input as Record<string, unknown>;
  if (typeof env.event_type !== "string") return undefined;
  const out: ExtractedEnvelope = { event_type: env.event_type };
  const payload = env.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    if (typeof p.severity_hint === "string") {
      out.severity_hint = p.severity_hint as WireSeverityHint;
    }
  }
  return out;
}

function readRiskReport(
  results: { layer: string; details?: Record<string, unknown> | undefined }[],
): { score: number; routes_to_hitl: boolean } | undefined {
  for (const r of results) {
    if (r.layer === "07_risk" && r.details && "risk" in r.details) {
      const risk = r.details.risk as { score?: unknown; routes_to_hitl?: unknown };
      if (typeof risk.score === "number" && typeof risk.routes_to_hitl === "boolean") {
        return { score: risk.score, routes_to_hitl: risk.routes_to_hitl };
      }
    }
  }
  return undefined;
}
