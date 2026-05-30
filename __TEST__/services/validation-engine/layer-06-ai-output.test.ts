/**
 * Layer 6 — AI Output Sanity tests (T-410).
 *
 * Covers the four L6 rules:
 *   1. bbox extent stays inside the [0,1] normalized image
 *   2. confidence ≥ operational floor
 *   3. evidence linkage non-sentinel + non-duplicate
 *   4. captured_at within the envelope timestamp window
 *
 * Sensor frames + non-detection inputs pass unconditionally.
 */
import { describe, expect, it } from "vitest";
import { createAiOutputSanityLayer } from "../../../services/validation-engine/src/layers/06-ai-output/index.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";

async function run(envelope: unknown, cfg?: Parameters<typeof createAiOutputSanityLayer>[0]) {
  return createAiOutputSanityLayer(cfg).run({
    submission_id: SUB_ID,
    payload: envelope,
    previous_results: [],
  });
}

function detection(overrides: Record<string, unknown> = {}): unknown {
  const base = {
    detection_id: "det-001",
    sensor_id: "CAM-N-03",
    frame_id: "frame-abc",
    detection_class: "fod",
    confidence: 0.82,
    severity_hint: "high",
    captured_at: "2026-05-29T09:59:30.000Z",
    ...overrides,
  };
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "ai.detection.fod.emitted",
    schema_version: "v1",
    source: { service: "test" },
    timestamp: "2026-05-29T09:59:35.000Z",
    payload: base,
  };
}

describe("L6 — happy path", () => {
  it("passes a canonical AI detection", async () => {
    const result = await run(detection());
    expect(result).toEqual({ layer: "06_ai_output", passed: true });
  });

  it("passes sensor frames unconditionally", async () => {
    const env = {
      event_id: "11111111-2222-3333-4444-555555555555",
      event_type: "sensor.frame.captured",
      schema_version: "v1",
      source: { service: "sensor-gateway" },
      timestamp: "2026-05-29T10:00:00.000Z",
      payload: { sensor_id: "CAM-N-03", confidence: 0 },
    };
    const result = await run(env);
    expect(result.passed).toBe(true);
  });
});

describe("L6 — bbox extent", () => {
  it("rejects a bbox extending past the right edge", async () => {
    const result = await run(detection({ bbox: { x: 0.8, y: 0.1, w: 0.3, h: 0.2 } }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("BBOX_EXTENT_OUT_OF_IMAGE");
  });

  it("rejects a bbox extending past the bottom edge", async () => {
    const result = await run(detection({ bbox: { x: 0.1, y: 0.9, w: 0.2, h: 0.2 } }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("BBOX_EXTENT_OUT_OF_IMAGE");
  });

  it("accepts a bbox exactly at the right edge (x+w == 1)", async () => {
    const result = await run(detection({ bbox: { x: 0.5, y: 0.1, w: 0.5, h: 0.2 } }));
    expect(result.passed).toBe(true);
  });

  it("passes when bbox is absent", async () => {
    const result = await run(detection());
    expect(result.passed).toBe(true);
  });
});

describe("L6 — confidence floor", () => {
  it("rejects confidence below the default floor (0.4)", async () => {
    const result = await run(detection({ confidence: 0.3 }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("CONFIDENCE_BELOW_MIN");
  });

  it("respects a tightened minConfidence", async () => {
    const result = await run(detection({ confidence: 0.7 }), { minConfidence: 0.8 });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("CONFIDENCE_BELOW_MIN");
  });

  it("accepts confidence exactly at the floor", async () => {
    const result = await run(detection({ confidence: 0.4 }));
    expect(result.passed).toBe(true);
  });
});

describe("L6 — evidence linkage", () => {
  it("rejects sentinel detection_id 'unknown'", async () => {
    const result = await run(detection({ detection_id: "unknown" }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("EVIDENCE_LINKAGE_BLANK");
  });

  it("rejects when detection_id == frame_id (duplicate sentinel)", async () => {
    const result = await run(detection({ detection_id: "frame-abc", frame_id: "frame-abc" }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("EVIDENCE_LINKAGE_DUPLICATE");
  });

  it("rejects when sensor_id collides with frame_id", async () => {
    const result = await run(
      detection({ sensor_id: "frame-abc", frame_id: "frame-abc", detection_id: "det-001" }),
    );
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("EVIDENCE_LINKAGE_DUPLICATE");
  });

  it("accepts realistic distinct identifiers", async () => {
    const result = await run(detection());
    expect(result.passed).toBe(true);
  });
});

describe("L6 — capture timestamp window", () => {
  it("rejects captured_at AFTER envelope.timestamp", async () => {
    const result = await run(
      detection({ captured_at: "2026-05-29T09:59:40.000Z" /* > 09:59:35 envelope */ }),
    );
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("CAPTURED_AT_AFTER_ENVELOPE");
  });

  it("rejects capture skew exceeding the configured max", async () => {
    // Envelope at 09:59:35, capture 30 min earlier → exceeds 5-min default.
    const result = await run(detection({ captured_at: "2026-05-29T09:29:35.000Z" }));
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("CAPTURE_SKEW_EXCEEDS_MAX");
  });

  it("accepts capture within the 5-minute default skew", async () => {
    const result = await run(detection({ captured_at: "2026-05-29T09:55:00.000Z" }));
    expect(result.passed).toBe(true);
  });
});
