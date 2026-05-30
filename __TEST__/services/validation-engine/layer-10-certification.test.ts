/**
 * Layer 10 — Final Certification tests (T-411).
 *
 * The terminal gate. Three outcomes covered:
 *   - L8 routed to HITL → fail HITL_PENDING
 *   - A required layer in previous_results failed →
 *     fail CERTIFICATION_INELIGIBLE
 *   - Else → pass + details.certification envelope
 */
import { describe, expect, it } from "vitest";
import { createCertificationLayer } from "../../../services/validation-engine/src/layers/10-certification/index.js";
import type { ValidationLayerResult } from "../../../services/validation-engine/src/layers/types.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";
const FIXED_NOW = new Date("2026-05-29T10:00:00.000Z");
const now = () => FIXED_NOW;

function envelope(): unknown {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "ai.detection.fod.emitted",
    payload: {},
  };
}

async function run(
  previous: ValidationLayerResult[],
  cfg: Parameters<typeof createCertificationLayer>[0] = {},
) {
  return createCertificationLayer({ now, ...cfg }).run({
    submission_id: SUB_ID,
    payload: envelope(),
    previous_results: previous,
  });
}

function passingPrior(): ValidationLayerResult[] {
  return [
    { layer: "01_input", passed: true },
    { layer: "02_schema", passed: true },
    { layer: "03_business_rules", passed: true },
    { layer: "04_source_of_truth", passed: true },
    { layer: "05_cross_system", passed: true },
    { layer: "06_ai_output", passed: true },
    { layer: "07_risk", passed: true },
    {
      layer: "08_human_review",
      passed: true,
      details: { hitl: { routed_to_hitl: false, priority: "normal", reasons: [] } },
    },
    { layer: "09_audit", passed: true },
  ];
}

describe("L10 — clean run", () => {
  it("certifies and emits a certification envelope", async () => {
    const result = await run(passingPrior());
    expect(result.passed).toBe(true);
    const cert = (
      result.details as {
        certification: { event_id: string; event_type: string; certified_at: string };
      }
    ).certification;
    expect(cert.event_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(cert.event_type).toBe("ai.detection.fod.emitted");
    expect(cert.certified_at).toBe(FIXED_NOW.toISOString());
  });
});

describe("L10 — HITL pending", () => {
  it("fails HITL_PENDING when L8 routed", async () => {
    const prior = passingPrior();
    prior[7] = {
      layer: "08_human_review",
      passed: true,
      details: {
        hitl: {
          routed_to_hitl: true,
          priority: "high",
          reasons: ["risk_score=0.800"],
        },
      },
    };
    const result = await run(prior);
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("HITL_PENDING");
    expect(result.error_message).toContain("risk_score=0.800");
  });
});

describe("L10 — required-layer failure", () => {
  it("fails CERTIFICATION_INELIGIBLE when a required layer failed", async () => {
    const prior = passingPrior();
    prior[2] = {
      layer: "03_business_rules",
      passed: false,
      error_code: "SOP_VIOLATION",
    };
    const result = await run(prior);
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("CERTIFICATION_INELIGIBLE");
    expect((result.details as { failed_layers: string[] }).failed_layers).toContain(
      "03_business_rules",
    );
  });

  it("ignores 07_risk failure (not in the required set by default)", async () => {
    // L7 RISK_EXCEPTION_THRESHOLD fails the run via short-circuit in
    // production; if it bubbles up to L10 in tests, the L7 failure
    // shouldn't *also* block certification by itself — the HITL gate
    // is the relevant signal.
    const prior = passingPrior();
    prior[6] = {
      layer: "07_risk",
      passed: false,
      error_code: "RISK_EXCEPTION_THRESHOLD",
    };
    const result = await run(prior);
    expect(result.passed).toBe(true);
  });

  it("respects a custom requiredLayers set", async () => {
    const prior = passingPrior();
    prior[6] = { layer: "07_risk", passed: false, error_code: "RISK_EXCEPTION_THRESHOLD" };
    const result = await run(prior, { requiredLayers: new Set(["07_risk"]) });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("CERTIFICATION_INELIGIBLE");
  });
});

describe("L10 — precedence", () => {
  it("HITL_PENDING wins over CERTIFICATION_INELIGIBLE when both apply", async () => {
    const prior = passingPrior();
    prior[2] = { layer: "03_business_rules", passed: false, error_code: "SOP_VIOLATION" };
    prior[7] = {
      layer: "08_human_review",
      passed: true,
      details: {
        hitl: {
          routed_to_hitl: true,
          priority: "normal",
          reasons: ["prior_layer_failure=03_business_rules"],
        },
      },
    };
    const result = await run(prior);
    expect(result.error_code).toBe("HITL_PENDING");
  });
});
