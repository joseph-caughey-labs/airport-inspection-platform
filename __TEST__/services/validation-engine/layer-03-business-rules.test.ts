/**
 * Layer 3 — Business Rule Validation tests (T-408).
 *
 * L3 applies SOP-derived policy rules to AI detections after L1+L2
 * have confirmed shape + schema. Each detector class gets its own
 * suite of rules; the tests below cover one happy path + each
 * SOP-mappable rejection per class, plus the cross-cutting "skip
 * for sensor frames" and "metadata absent → no enforcement" cases.
 */
import { describe, expect, it } from "vitest";
import { createBusinessRulesLayer } from "../../../services/validation-engine/src/layers/03-business-rules/index.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";

function layer(cfg: Parameters<typeof createBusinessRulesLayer>[0] = {}) {
  return createBusinessRulesLayer(cfg);
}

async function run(envelope: unknown, cfg?: Parameters<typeof createBusinessRulesLayer>[0]) {
  return layer(cfg).run({
    submission_id: SUB_ID,
    payload: envelope,
    previous_results: [],
  });
}

function detection(
  detectionClass: string,
  severity: string,
  metadata: Record<string, unknown> = {},
): unknown {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: `ai.detection.${detectionClass}.emitted`,
    schema_version: "v1",
    source: { service: "test" },
    timestamp: "2026-05-29T10:00:00.000Z",
    payload: {
      detection_id: "det-001",
      sensor_id: "CAM-N-03",
      frame_id: "frame-1",
      detection_class: detectionClass,
      confidence: 0.9,
      severity_hint: severity,
      captured_at: "2026-05-29T10:00:00.000Z",
      metadata,
    },
  };
}

describe("L3 — happy path", () => {
  it("passes a critical FOD on an active runway", async () => {
    const result = await run(
      detection("fod", "critical", { object_dimension_cm: 5, location_category: "runway_active" }),
    );
    expect(result).toEqual({ layer: "03_business_rules", passed: true });
  });

  it("passes when metadata is absent (rules require their field to fire)", async () => {
    const result = await run(detection("fod", "low"));
    expect(result.passed).toBe(true);
  });

  it("skips sensor frame events", async () => {
    const env = {
      event_id: "11111111-2222-3333-4444-555555555555",
      event_type: "sensor.frame.captured",
      schema_version: "v1",
      source: { service: "sensor-gateway" },
      timestamp: "2026-05-29T10:00:00.000Z",
      payload: { sensor_id: "CAM-N-03" },
    };
    const result = await run(env);
    expect(result.passed).toBe(true);
  });

  it("passes anomaly detections (no SOP-driven rules apply)", async () => {
    const result = await run(detection("anomaly", "low", { whatever: true }));
    expect(result.passed).toBe(true);
  });
});

describe("L3 — FOD rules", () => {
  it("rejects a FOD below the minimum object dimension", async () => {
    const result = await run(detection("fod", "high", { object_dimension_cm: 1 }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("FOD_BELOW_MIN_DIMENSION");
  });

  it("accepts FOD at exactly the minimum dimension (boundary)", async () => {
    const result = await run(detection("fod", "high", { object_dimension_cm: 2 }));
    expect(result.passed).toBe(true);
  });

  it("rejects a FOD on runway_active reported as `medium` (must be critical)", async () => {
    const result = await run(detection("fod", "medium", { location_category: "runway_active" }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("FOD_LOCATION_SEVERITY_MISMATCH");
    const failure = (result.details?.failures as { actual: string; expected: string }[])[0]!;
    expect(failure.expected).toBe("critical");
    expect(failure.actual).toBe("medium");
  });

  it("rejects a FOD on apron reported as `critical` (must be low)", async () => {
    const result = await run(detection("fod", "critical", { location_category: "apron" }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("FOD_LOCATION_SEVERITY_MISMATCH");
  });

  it("ignores an unrecognized location_category (defers to L6 sanity)", async () => {
    const result = await run(detection("fod", "low", { location_category: "ramp_bravo" }));
    expect(result.passed).toBe(true);
  });
});

describe("L3 — crack rules", () => {
  it("rejects a 30mm crack reported as `medium` (band requires `critical`)", async () => {
    const result = await run(detection("crack", "medium", { crack_width_mm: 30 }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("CRACK_SEVERITY_BAND_MISMATCH");
    const failure = (result.details?.failures as { expected: string }[])[0]!;
    expect(failure.expected).toBe("critical");
  });

  it("accepts a 10mm crack reported as `medium` (band: <= 12mm)", async () => {
    const result = await run(detection("crack", "medium", { crack_width_mm: 10 }));
    expect(result.passed).toBe(true);
  });

  it("accepts a crack with no width metadata (rule requires it)", async () => {
    const result = await run(detection("crack", "low"));
    expect(result.passed).toBe(true);
  });

  it("treats widths exactly at a band edge as that band (6mm → low)", async () => {
    const result = await run(detection("crack", "low", { crack_width_mm: 6 }));
    expect(result.passed).toBe(true);
  });

  it("rejects when severity doesn't match the next band (7mm → medium)", async () => {
    const result = await run(detection("crack", "low", { crack_width_mm: 7 }));
    expect(result.passed).toBe(false);
  });
});

describe("L3 — snowbank rules", () => {
  it("rejects a snowbank above max height", async () => {
    const result = await run(detection("snowbank", "critical", { snowbank_height_cm: 260 }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("SNOWBANK_HEIGHT_OVER_MAX");
  });

  it("accepts a snowbank at exactly max height (boundary)", async () => {
    const result = await run(detection("snowbank", "high", { snowbank_height_cm: 240 }));
    expect(result.passed).toBe(true);
  });

  it("rejects a snowbank with too-close setback near a runway", async () => {
    const result = await run(
      detection("snowbank", "high", { setback_m: 4, surface_kind: "runway" }),
    );
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("SNOWBANK_SETBACK_BELOW_MIN");
  });

  it("accepts a taxiway setback that would fail the runway threshold", async () => {
    // 4m > 3m taxiway min, but < 6m runway min — so surface_kind matters.
    const result = await run(
      detection("snowbank", "medium", { setback_m: 4, surface_kind: "taxiway" }),
    );
    expect(result.passed).toBe(true);
  });

  it("ignores setback when surface_kind is absent", async () => {
    const result = await run(detection("snowbank", "medium", { setback_m: 2 }));
    expect(result.passed).toBe(true);
  });
});

describe("L3 — wildlife rules", () => {
  it("rejects a high-risk species reported as `low`", async () => {
    const result = await run(detection("wildlife", "low", { species: "deer" }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("WILDLIFE_HIGH_RISK_SEVERITY_TOO_LOW");
  });

  it("accepts a high-risk species reported as `critical`", async () => {
    const result = await run(detection("wildlife", "critical", { species: "coyote" }));
    expect(result.passed).toBe(true);
  });

  it("accepts a low-risk species reported as `low`", async () => {
    const result = await run(detection("wildlife", "low", { species: "squirrel" }));
    expect(result.passed).toBe(true);
  });
});

describe("L3 — config overrides", () => {
  it("respects a tightened FOD minimum dimension", async () => {
    const result = await run(detection("fod", "high", { object_dimension_cm: 3 }), {
      thresholds: { fod: { minObjectDimensionCm: 5 } },
    });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("FOD_BELOW_MIN_DIMENSION");
  });

  it("respects an extended wildlife high-risk list", async () => {
    const result = await run(detection("wildlife", "low", { species: "alligator" }), {
      thresholds: { wildlife: { highRiskClasses: ["alligator"] } },
    });
    expect(result.passed).toBe(false);
  });
});
