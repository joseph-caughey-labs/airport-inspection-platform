/**
 * Layer 2 — Schema & Contract Validation tests (T-407).
 *
 * The contract gate. Where L1 just checked "is the envelope shaped
 * right?", L2 confirms every field conforms to the canonical zod
 * schema. Three responsibilities:
 *
 *   1. Envelope (EventEnvelope from shared-contracts)
 *   2. schema_version is in the supported set
 *   3. payload schema based on event_type:
 *      - sensor.frame.captured     → SensorFramePayload
 *      - ai.detection.*.emitted    → AiDetectionPayload
 *      - anything else             → UNSUPPORTED_EVENT_TYPE
 *
 * Each test mutates one field of a known-good envelope to keep
 * assertions focused on the rule under test.
 */
import { describe, expect, it } from "vitest";
import { createSchemaValidationLayer } from "../../../services/validation-engine/src/layers/02-schema/index.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";

function layer(cfg: Parameters<typeof createSchemaValidationLayer>[0] = {}) {
  return createSchemaValidationLayer(cfg);
}

async function run(envelope: unknown) {
  return layer().run({
    submission_id: SUB_ID,
    payload: envelope,
    previous_results: [],
  });
}

function validDetectionEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "ai.detection.fod.emitted",
    schema_version: "v1",
    source: { service: "ai-inference" },
    timestamp: "2026-05-29T09:59:30.000Z",
    payload: {
      detection_id: "det-001",
      sensor_id: "CAM-N-03",
      frame_id: "frame-abc",
      detection_class: "fod",
      confidence: 0.82,
      severity_hint: "high",
      captured_at: "2026-05-29T09:59:30.000Z",
    },
    ...overrides,
  };
}

function validSensorFrameEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "sensor.frame.captured",
    schema_version: "v1",
    source: { service: "sensor-gateway" },
    timestamp: "2026-05-29T09:59:30.000Z",
    payload: {
      sensor_id: "CAM-N-03",
      sensor_type: "camera",
      frame_id: "frame-abc",
      captured_at: "2026-05-29T09:59:30.000Z",
      geo: { lat: 40.6413, lng: -73.7781 },
      metadata: { width: 1920 },
    },
    ...overrides,
  };
}

describe("L2 — happy path", () => {
  it("passes a canonical AI detection event", async () => {
    const result = await run(validDetectionEvent());
    expect(result).toEqual({ layer: "02_schema", passed: true });
  });

  it("passes a canonical sensor frame event", async () => {
    const result = await run(validSensorFrameEvent());
    expect(result).toEqual({ layer: "02_schema", passed: true });
  });

  it("accepts an optional bbox + geo on the AI detection payload", async () => {
    const env = validDetectionEvent({
      payload: {
        ...(validDetectionEvent() as { payload: Record<string, unknown> }).payload,
        bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        geo: { lat: 40, lng: -73 },
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(true);
  });
});

describe("L2 — envelope schema", () => {
  it("fails when schema_version doesn't match the version regex", async () => {
    const result = await run(validDetectionEvent({ schema_version: "1.0" }));
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes.some((c) => c.startsWith("ENVELOPE_SCHEMA__"))).toBe(true);
  });

  it("fails when source.service is empty", async () => {
    const result = await run(validDetectionEvent({ source: { service: "" } }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { path?: string }[]) ?? [];
    expect(failures.some((f) => f.path === "source.service")).toBe(true);
  });

  it("fails when idempotency_key exceeds 200 chars", async () => {
    const result = await run(validDetectionEvent({ idempotency_key: "x".repeat(201) }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { path?: string }[]) ?? [];
    expect(failures.some((f) => f.path === "idempotency_key")).toBe(true);
  });
});

describe("L2 — supported schema_version", () => {
  it("fails UNSUPPORTED_SCHEMA_VERSION on an unknown major", async () => {
    const result = await run(validDetectionEvent({ schema_version: "v9" }));
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes).toContain("UNSUPPORTED_SCHEMA_VERSION");
  });

  it("accepts a version when the layer is configured to support it", async () => {
    const result = await layer({ supportedSchemaVersions: ["v1", "v2"] }).run({
      submission_id: SUB_ID,
      payload: validDetectionEvent({ schema_version: "v2" }),
      previous_results: [],
    });
    expect(result.passed).toBe(true);
  });
});

describe("L2 — AI detection payload schema", () => {
  it("rejects an unknown detection_class", async () => {
    const env = validDetectionEvent({
      payload: {
        ...(validDetectionEvent() as { payload: Record<string, unknown> }).payload,
        detection_class: "ufo",
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes.some((c) => c.startsWith("AI_DETECTION_PAYLOAD__"))).toBe(true);
  });

  it("rejects confidence > 1", async () => {
    const env = validDetectionEvent({
      payload: {
        ...(validDetectionEvent() as { payload: Record<string, unknown> }).payload,
        confidence: 1.2,
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { path?: string }[]) ?? [];
    expect(failures.some((f) => f.path === "payload.confidence")).toBe(true);
  });

  it("rejects bbox with w=0 (degenerate)", async () => {
    const env = validDetectionEvent({
      payload: {
        ...(validDetectionEvent() as { payload: Record<string, unknown> }).payload,
        bbox: { x: 0.1, y: 0.1, w: 0, h: 0.5 },
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { path?: string }[]) ?? [];
    expect(failures.some((f) => f.path === "payload.bbox.w")).toBe(true);
  });

  it("rejects an unknown severity_hint", async () => {
    const env = validDetectionEvent({
      payload: {
        ...(validDetectionEvent() as { payload: Record<string, unknown> }).payload,
        severity_hint: "extreme",
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes.some((c) => c.startsWith("AI_DETECTION_PAYLOAD__"))).toBe(true);
  });

  it("rejects when required detection_id is missing", async () => {
    const env = validDetectionEvent({
      payload: {
        sensor_id: "CAM-N-03",
        frame_id: "frame-abc",
        detection_class: "fod",
        confidence: 0.5,
        severity_hint: "high",
        captured_at: "2026-05-29T09:59:30.000Z",
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { path?: string }[]) ?? [];
    expect(failures.some((f) => f.path === "payload.detection_id")).toBe(true);
  });
});

describe("L2 — sensor frame payload schema", () => {
  it("rejects an unknown sensor_type", async () => {
    const env = validSensorFrameEvent({
      payload: {
        ...(validSensorFrameEvent() as { payload: Record<string, unknown> }).payload,
        sensor_type: "ultrasonic",
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes.some((c) => c.startsWith("SENSOR_FRAME_PAYLOAD__"))).toBe(true);
  });

  it("rejects a missing geo (required for sensor frames)", async () => {
    const env = validSensorFrameEvent({
      payload: {
        sensor_id: "CAM-N-03",
        sensor_type: "camera",
        frame_id: "frame-abc",
        captured_at: "2026-05-29T09:59:30.000Z",
        metadata: {},
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { path?: string }[]) ?? [];
    expect(failures.some((f) => f.path === "payload.geo")).toBe(true);
  });
});

describe("L2 — unsupported event_type", () => {
  it("fails UNSUPPORTED_EVENT_TYPE for an event_type with no L2 schema", async () => {
    const result = await run(
      validDetectionEvent({
        event_type: "operator.action.acknowledged",
        payload: { whatever: true },
      }),
    );
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes).toContain("UNSUPPORTED_EVENT_TYPE");
  });
});

describe("L2 — combined surface", () => {
  it("collects every failure into details.failures in one pass", async () => {
    // Bad schema_version + bad confidence in one envelope; both
    // should be surfaced.
    const env = validDetectionEvent({
      schema_version: "v9",
      payload: {
        ...(validDetectionEvent() as { payload: Record<string, unknown> }).payload,
        confidence: 5,
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes).toContain("UNSUPPORTED_SCHEMA_VERSION");
    expect(codes.some((c) => c.startsWith("AI_DETECTION_PAYLOAD__"))).toBe(true);
  });

  it("surfaces the FIRST failure as top-level error_code", async () => {
    const env = validDetectionEvent({ schema_version: "1.0" });
    const result = await run(env);
    expect(result.passed).toBe(false);
    // EventEnvelope parse runs first → ENVELOPE_SCHEMA__ failure
    // surfaces as the primary error_code.
    expect(result.error_code?.startsWith("ENVELOPE_SCHEMA__")).toBe(true);
  });
});
