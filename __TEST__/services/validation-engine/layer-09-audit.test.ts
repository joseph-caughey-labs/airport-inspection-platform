/**
 * Layer 9 — Audit Trail Emission tests (T-411).
 *
 * L9 always passes. It builds a ValidationAuditRecord from
 * ctx.previous_results + envelope summary and (optionally) hands it
 * to an AuditSink. With no sink, the run still carries the envelope
 * summary on details.audit.
 */
import { describe, expect, it } from "vitest";
import { createAuditEmissionLayer } from "../../../services/validation-engine/src/layers/09-audit/index.js";
import { RecordingAuditSink } from "../../../services/validation-engine/src/audit/sink.js";
import type { ValidationLayerResult } from "../../../services/validation-engine/src/layers/types.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";
const FIXED_NOW = new Date("2026-05-29T10:00:00.000Z");
const now = () => FIXED_NOW;

function envelope(): unknown {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "ai.detection.fod.emitted",
    timestamp: "2026-05-29T09:59:30.000Z",
    payload: {},
  };
}

async function run(
  cfg: Parameters<typeof createAuditEmissionLayer>[0] = {},
  previous: ValidationLayerResult[] = [],
) {
  return createAuditEmissionLayer({ now, ...cfg }).run({
    submission_id: SUB_ID,
    payload: envelope(),
    previous_results: previous,
  });
}

describe("L9 — emit + record-keeping", () => {
  it("always passes and stamps emitted_at + layer_count on details.audit", async () => {
    const result = await run({}, [
      { layer: "01_input", passed: true },
      { layer: "02_schema", passed: true },
    ]);
    expect(result.passed).toBe(true);
    expect(result.details!.audit).toMatchObject({
      emitted_at: FIXED_NOW.toISOString(),
      layer_count: 2,
    });
  });

  it("writes the full record to a configured sink", async () => {
    const sink = new RecordingAuditSink();
    const prior: ValidationLayerResult[] = [
      { layer: "01_input", passed: true },
      { layer: "02_schema", passed: false, error_code: "BOOM" },
    ];
    await run({ sink }, prior);
    expect(sink.records).toHaveLength(1);
    const rec = sink.records[0]!;
    expect(rec.submission_id).toBe(SUB_ID);
    expect(rec.envelope).toEqual({
      event_id: "11111111-2222-3333-4444-555555555555",
      event_type: "ai.detection.fod.emitted",
      timestamp: "2026-05-29T09:59:30.000Z",
    });
    expect(rec.layers).toEqual(prior);
    expect(rec.emitted_at).toBe(FIXED_NOW.toISOString());
  });

  it("propagates the L7 risk report onto the audit record", async () => {
    const sink = new RecordingAuditSink();
    const prior: ValidationLayerResult[] = [
      {
        layer: "07_risk",
        passed: true,
        details: {
          risk: {
            score: 0.72,
            factors: {
              confidence_gap: 0.5,
              freshness: 0.2,
              severity_weight: 0.8,
              prior_failure_density: 0,
            },
            routes_to_hitl: true,
          },
        },
      },
    ];
    await run({ sink }, prior);
    expect(sink.records[0]!.risk).toMatchObject({ score: 0.72, routes_to_hitl: true });
  });

  it("propagates the L8 HITL decision onto the audit record", async () => {
    const sink = new RecordingAuditSink();
    const prior: ValidationLayerResult[] = [
      {
        layer: "08_human_review",
        passed: true,
        details: {
          hitl: { routed_to_hitl: true, priority: "high", reasons: ["risk_score=0.800"] },
        },
      },
    ];
    await run({ sink }, prior);
    expect(sink.records[0]!.hitl).toMatchObject({ routed_to_hitl: true, priority: "high" });
  });
});
