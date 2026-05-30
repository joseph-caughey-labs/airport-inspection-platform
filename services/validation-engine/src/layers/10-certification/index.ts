/**
 * Layer 10 — Final Certification.
 *
 * The terminal gate. L10 looks back across `previous_results` and
 * decides whether the run is certified to drive incident creation
 * downstream:
 *
 *   1. **HITL pending** — L8 routed this run to human review.
 *      Certification waits for a reviewer decision; the layer
 *      fails with `HITL_PENDING` so the orchestrator's
 *      `certified=false` flips, and the bridge in event-pipeline
 *      (future) knows not to create an incident yet.
 *
 *   2. **Required-layer failure** — defense-in-depth for the case
 *      where short-circuit is disabled in tests + a non-required
 *      layer failed without being upgraded to a HITL signal. L10
 *      fails with `CERTIFICATION_INELIGIBLE` rather than silently
 *      certifying.
 *
 *   3. **Clean run** — passes with `details.certification` holding
 *      the canonical envelope a downstream bridge would forward to
 *      incident-service: `{ event_id, event_type, certified_at }`.
 *
 * In production the orchestrator short-circuits at the first
 * failing layer, so L10 only runs when L1–L9 all passed. The
 * required-layer check therefore mostly fires in tests where
 * `shortCircuit: false` lets every layer run.
 */
import type { ValidationLayer, ValidationLayerId, ValidationLayerResult } from "../types.js";
import type { HitlDecision } from "../08-human-review/index.js";

export interface CertificationConfig {
  /**
   * Layers whose failure blocks certification. Default: every layer
   * EXCEPT 07_risk (which doesn't gate when below the exception
   * threshold; its job is to surface the score) and 08_human_review
   * (which always passes — the routing decision blocks via HITL
   * handling, not a layer fail) and 10_certification itself.
   */
  requiredLayers?: ReadonlySet<ValidationLayerId>;
  now?: () => Date;
}

export const DEFAULT_REQUIRED_LAYERS: ReadonlySet<ValidationLayerId> = new Set([
  "01_input",
  "02_schema",
  "03_business_rules",
  "04_source_of_truth",
  "05_cross_system",
  "06_ai_output",
  "09_audit",
]);

interface CertificationEnvelope {
  event_id?: string;
  event_type?: string;
  certified_at: string;
}

export function createCertificationLayer(cfg: CertificationConfig = {}): ValidationLayer {
  const required = cfg.requiredLayers ?? DEFAULT_REQUIRED_LAYERS;
  const now = cfg.now ?? (() => new Date());

  return {
    id: "10_certification",
    name: "Final Certification",
    async run(ctx) {
      const hitl = readHitlDecision(ctx.previous_results);
      if (hitl?.routed_to_hitl) {
        return {
          layer: "10_certification",
          passed: false,
          error_code: "HITL_PENDING",
          error_message: `routed to HITL (${hitl.reasons.join("; ")}); reviewer decision required`,
          details: { hitl },
        };
      }

      const failedRequired = ctx.previous_results.filter((r) => !r.passed && required.has(r.layer));
      if (failedRequired.length > 0) {
        return {
          layer: "10_certification",
          passed: false,
          error_code: "CERTIFICATION_INELIGIBLE",
          error_message: `required layers failed: ${failedRequired.map((r) => r.layer).join(", ")}`,
          details: { failed_layers: failedRequired.map((r) => r.layer) },
        };
      }

      const env = extractEnvelope(ctx.payload);
      const certification: CertificationEnvelope = {
        ...(env.event_id ? { event_id: env.event_id } : {}),
        ...(env.event_type ? { event_type: env.event_type } : {}),
        certified_at: now().toISOString(),
      };
      return {
        layer: "10_certification",
        passed: true,
        details: { certification },
      };
    },
  };
}

export const certificationLayer: ValidationLayer = createCertificationLayer();

function extractEnvelope(input: unknown): { event_id?: string; event_type?: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env = input as Record<string, unknown>;
  const out: { event_id?: string; event_type?: string } = {};
  if (typeof env.event_id === "string") out.event_id = env.event_id;
  if (typeof env.event_type === "string") out.event_type = env.event_type;
  return out;
}

function readHitlDecision(results: ValidationLayerResult[]): HitlDecision | undefined {
  for (const r of results) {
    if (r.layer === "08_human_review" && r.details && "hitl" in r.details) {
      return r.details.hitl as HitlDecision;
    }
  }
  return undefined;
}
