/**
 * Layer 7 — Risk & Exception Scoring tests (T-410).
 *
 * L7 produces a transparent named-factor risk score on
 * `details.risk` and signals `routes_to_hitl` for L8. Only the
 * exception case fails the layer.
 *
 * The tests pin down the score by injecting a deterministic clock
 * + crafted payloads — the score is a deterministic function of
 * (confidence, severity, capture age, prior failures).
 */
import { describe, expect, it } from "vitest";
import { createRiskScoringLayer } from "../../../services/validation-engine/src/layers/07-risk/index.js";
import type { ValidationLayerResult } from "../../../services/validation-engine/src/layers/types.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-05-29T10:00:00.000Z");
const now = () => NOW;

async function run(
  envelope: unknown,
  cfg: Parameters<typeof createRiskScoringLayer>[0] = {},
  previous: ValidationLayerResult[] = [],
) {
  return createRiskScoringLayer({ now, ...cfg }).run({
    submission_id: SUB_ID,
    payload: envelope,
    previous_results: previous,
  });
}

function detection(overrides: Record<string, unknown> = {}): unknown {
  const base = {
    detection_id: "det-001",
    sensor_id: "CAM-N-03",
    frame_id: "frame-abc",
    detection_class: "fod",
    confidence: 0.8,
    severity_hint: "medium",
    captured_at: NOW.toISOString(),
    ...overrides,
  };
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "ai.detection.fod.emitted",
    schema_version: "v1",
    source: { service: "test" },
    timestamp: NOW.toISOString(),
    payload: base,
  };
}

describe("L7 — passes + populates details.risk", () => {
  it("emits a risk report with score + factors + routes_to_hitl", async () => {
    const result = await run(detection());
    expect(result.passed).toBe(true);
    expect(result.details?.risk).toBeDefined();
    const risk = result.details!.risk as {
      score: number;
      factors: Record<string, number>;
      routes_to_hitl: boolean;
    };
    expect(typeof risk.score).toBe("number");
    expect(risk.factors).toMatchObject({
      confidence_gap: expect.any(Number),
      freshness: expect.any(Number),
      severity_weight: expect.any(Number),
      prior_failure_density: expect.any(Number),
    });
  });

  it("scores a fresh, high-confidence, medium-severity detection below the HITL threshold", async () => {
    const result = await run(detection({ confidence: 0.9, severity_hint: "medium" }));
    const risk = result.details!.risk as { score: number; routes_to_hitl: boolean };
    expect(risk.routes_to_hitl).toBe(false);
    expect(risk.score).toBeLessThan(0.6);
  });
});

describe("L7 — factor sensitivity", () => {
  it("low confidence raises confidence_gap → higher score", async () => {
    const high = await run(detection({ confidence: 0.95 }));
    const low = await run(detection({ confidence: 0.5 }));
    expect((low.details!.risk as { score: number }).score).toBeGreaterThan(
      (high.details!.risk as { score: number }).score,
    );
  });

  it("older captured_at raises freshness → higher score", async () => {
    const fresh = await run(detection({ captured_at: NOW.toISOString() }));
    const stale = await run(
      detection({ captured_at: new Date(NOW.getTime() - 30 * 60_000).toISOString() }),
    );
    expect((stale.details!.risk as { score: number }).score).toBeGreaterThan(
      (fresh.details!.risk as { score: number }).score,
    );
  });

  it("critical severity raises severity_weight → higher score", async () => {
    const info = await run(detection({ severity_hint: "info" }));
    const crit = await run(detection({ severity_hint: "critical" }));
    expect((crit.details!.risk as { score: number }).score).toBeGreaterThan(
      (info.details!.risk as { score: number }).score,
    );
  });

  it("more prior failures raises prior_failure_density → higher score", async () => {
    const clean = await run(detection());
    const dirty = await run(detection(), {}, [
      { layer: "01_input", passed: false },
      { layer: "02_schema", passed: false },
      { layer: "03_business_rules", passed: false },
    ]);
    expect((dirty.details!.risk as { score: number }).score).toBeGreaterThan(
      (clean.details!.risk as { score: number }).score,
    );
  });
});

describe("L7 — HITL routing", () => {
  it("routes to HITL when score crosses the hitl threshold", async () => {
    // Low confidence + critical severity + stale + prior failures all together.
    const result = await run(
      detection({
        confidence: 0.3,
        severity_hint: "critical",
        captured_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      }),
      {},
      [
        { layer: "01_input", passed: false },
        { layer: "02_schema", passed: false },
      ],
    );
    expect(result.passed).toBe(true);
    expect((result.details!.risk as { routes_to_hitl: boolean }).routes_to_hitl).toBe(true);
  });

  it("respects a custom hitl threshold", async () => {
    const result = await run(detection({ confidence: 0.9 }), { hitlScoreThreshold: 0.05 });
    expect((result.details!.risk as { routes_to_hitl: boolean }).routes_to_hitl).toBe(true);
  });
});

describe("L7 — exception threshold", () => {
  it("fails RISK_EXCEPTION_THRESHOLD when score >= exception threshold", async () => {
    // Force the worst-case score by tightening the exception threshold.
    const result = await run(
      detection({
        confidence: 0.1,
        severity_hint: "critical",
        captured_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      }),
      { exceptionScoreThreshold: 0.5 },
    );
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("RISK_EXCEPTION_THRESHOLD");
    // Even on rejection, the report rides on details.risk so the
    // audit trail captures the score.
    expect(result.details?.risk).toBeDefined();
  });
});

describe("L7 — non-detection inputs", () => {
  it("passes sensor frames without computing a risk report", async () => {
    const env = {
      event_id: "11111111-2222-3333-4444-555555555555",
      event_type: "sensor.frame.captured",
      schema_version: "v1",
      source: { service: "sensor-gateway" },
      timestamp: NOW.toISOString(),
      payload: { sensor_id: "CAM-N-03" },
    };
    const result = await run(env);
    expect(result.passed).toBe(true);
    expect(result.details?.risk).toBeUndefined();
  });
});
