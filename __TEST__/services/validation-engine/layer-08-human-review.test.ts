/**
 * Layer 8 — Human-in-the-Loop Routing tests (T-411).
 *
 * L8 always passes; it produces a routing decision on details.hitl
 * based on L7's risk report and any prior failures.
 */
import { describe, expect, it } from "vitest";
import { createHumanReviewLayer } from "../../../services/validation-engine/src/layers/08-human-review/index.js";
import type { ValidationLayerResult } from "../../../services/validation-engine/src/layers/types.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";

async function run(envelope: unknown, previous: ValidationLayerResult[] = []) {
  return createHumanReviewLayer().run({
    submission_id: SUB_ID,
    payload: envelope,
    previous_results: previous,
  });
}

function detection(severity: string = "medium"): unknown {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "ai.detection.fod.emitted",
    payload: { severity_hint: severity, confidence: 0.8 },
  };
}

function riskResult(routes: boolean, score = 0.7): ValidationLayerResult {
  return {
    layer: "07_risk",
    passed: true,
    details: {
      risk: {
        score,
        factors: {
          confidence_gap: 0,
          freshness: 0,
          severity_weight: 0,
          prior_failure_density: 0,
        },
        routes_to_hitl: routes,
      },
    },
  };
}

describe("L8 — routing decision", () => {
  it("doesn't route when L7 says routes_to_hitl=false and no prior failures", async () => {
    const result = await run(detection(), [riskResult(false)]);
    expect(result.passed).toBe(true);
    const hitl = (result.details as { hitl: { routed_to_hitl: boolean; reasons: string[] } }).hitl;
    expect(hitl.routed_to_hitl).toBe(false);
    expect(hitl.reasons).toEqual([]);
  });

  it("routes when L7 says routes_to_hitl=true", async () => {
    const result = await run(detection(), [riskResult(true, 0.72)]);
    const hitl = (result.details as { hitl: { routed_to_hitl: boolean; reasons: string[] } }).hitl;
    expect(hitl.routed_to_hitl).toBe(true);
    expect(hitl.reasons[0]).toMatch(/risk_score=0\.720/);
  });

  it("routes when any prior layer failed (even without L7 routing signal)", async () => {
    const result = await run(detection(), [
      { layer: "03_business_rules", passed: false, error_code: "SOP_VIOLATION" },
      riskResult(false),
    ]);
    const hitl = (result.details as { hitl: { routed_to_hitl: boolean; reasons: string[] } }).hitl;
    expect(hitl.routed_to_hitl).toBe(true);
    expect(hitl.reasons.some((r) => r.includes("03_business_rules"))).toBe(true);
  });
});

describe("L8 — priority", () => {
  it("assigns high priority when routed + severity=critical", async () => {
    const result = await run(detection("critical"), [riskResult(true)]);
    const hitl = (result.details as { hitl: { priority: string } }).hitl;
    expect(hitl.priority).toBe("high");
  });

  it("assigns normal priority when routed + severity=medium", async () => {
    const result = await run(detection("medium"), [riskResult(true)]);
    const hitl = (result.details as { hitl: { priority: string } }).hitl;
    expect(hitl.priority).toBe("normal");
  });

  it("keeps priority=normal when not routed even on critical severity", async () => {
    const result = await run(detection("critical"), [riskResult(false)]);
    const hitl = (result.details as { hitl: { priority: string } }).hitl;
    expect(hitl.priority).toBe("normal");
  });
});

describe("L8 — non-detection inputs", () => {
  it("passes sensor frames without producing a hitl decision", async () => {
    const env = {
      event_id: "x",
      event_type: "sensor.frame.captured",
      payload: { sensor_id: "CAM-N-03" },
    };
    const result = await run(env);
    expect(result.passed).toBe(true);
    expect(result.details).toBeUndefined();
  });
});
