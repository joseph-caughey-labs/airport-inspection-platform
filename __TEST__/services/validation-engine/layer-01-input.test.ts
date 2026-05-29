/**
 * Layer 1 — Input Validation tests (T-406).
 *
 * Covers the six L1 rules:
 *   1. Envelope is an object.
 *   2. Required top-level fields are present.
 *   3. event_id is a UUID.
 *   4. event_type is non-empty + matches the ai.detection pattern
 *      when it claims to be one.
 *   5. timestamp parses + sits within the window.
 *   6. payload exists + is an object + geo (if present) is in range.
 *
 * Tests build a `validEnvelope()` helper and then mutate one field
 * per test — keeps assertions specific to the rule under test.
 */
import { describe, expect, it } from "vitest";
import { createInputValidationLayer } from "../../../services/validation-engine/src/layers/01-input/index.js";

const FROZEN_NOW = new Date("2026-05-29T10:00:00.000Z");
const now = () => FROZEN_NOW;

function layer(opts: Parameters<typeof createInputValidationLayer>[0] = { now }) {
  return createInputValidationLayer({ now, ...opts });
}

async function run(envelope: unknown) {
  return layer().run({
    submission_id: "00000000-0000-0000-0000-000000000001",
    payload: envelope,
    previous_results: [],
  });
}

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "ai.detection.fod.emitted",
    schema_version: "v1",
    source: { service: "ai-inference" },
    timestamp: "2026-05-29T09:59:30.000Z",
    payload: {
      sensor_id: "CAM-N-03",
      detection_class: "fod",
      confidence: 0.82,
      geo: { lat: 40.6413, lng: -73.7781 },
    },
    ...overrides,
  };
}

describe("L1 — happy path", () => {
  it("passes a canonical AI detection envelope", async () => {
    const result = await run(validEnvelope());
    expect(result).toEqual({ layer: "01_input", passed: true });
  });

  it("passes when geo is absent (it's optional)", async () => {
    const env = validEnvelope({
      payload: { sensor_id: "CAM-N-03", detection_class: "fod", confidence: 0.5 },
    });
    const result = await run(env);
    expect(result.passed).toBe(true);
  });
});

describe("L1 — envelope shape", () => {
  it("rejects a non-object envelope", async () => {
    const result = await run("not an envelope");
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("ENVELOPE_NOT_OBJECT");
  });

  it("rejects an array envelope", async () => {
    const result = await run([1, 2, 3]);
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("ENVELOPE_NOT_OBJECT");
  });

  it("rejects null", async () => {
    const result = await run(null);
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("ENVELOPE_NOT_OBJECT");
  });
});

describe("L1 — required fields", () => {
  it("flags missing event_id", async () => {
    const env = validEnvelope();
    delete (env as Record<string, unknown>).event_id;
    const result = await run(env);
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("MISSING_FIELD");
    const failures = (result.details?.failures as { field?: string }[]) ?? [];
    expect(failures.some((f) => f.field === "event_id")).toBe(true);
  });

  it("collects ALL missing-field failures in a single pass", async () => {
    // Operators want to see every L1 issue at once, not fix one field
    // and resubmit to learn about the next.
    const result = await run({
      event_id: "11111111-2222-3333-4444-555555555555",
      event_type: "ai.detection.fod.emitted",
      // schema_version, source, timestamp, payload all missing
    });
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { field?: string }[]) ?? [];
    const missingFields = failures.filter((f) => f.field !== undefined).map((f) => f.field);
    expect(missingFields).toEqual(
      expect.arrayContaining(["schema_version", "source", "timestamp", "payload"]),
    );
  });
});

describe("L1 — event_id UUID format", () => {
  it("rejects a non-UUID event_id", async () => {
    const result = await run(validEnvelope({ event_id: "not-a-uuid" }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "INVALID_UUID")).toBe(true);
  });
});

describe("L1 — event_type", () => {
  it("rejects an empty event_type", async () => {
    const result = await run(validEnvelope({ event_type: "" }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "EMPTY_EVENT_TYPE")).toBe(true);
  });

  it("rejects a malformed ai.detection.* event_type", async () => {
    const result = await run(validEnvelope({ event_type: "ai.detection.fod" }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "INVALID_AI_DETECTION_EVENT_TYPE")).toBe(true);
  });

  it("accepts a non-ai-detection event_type without enforcing the pattern", async () => {
    // L2 owns the per-event-type schema; L1 only enforces the
    // ai.detection.* pattern when the caller declares it.
    const result = await run(validEnvelope({ event_type: "sensor.frame.captured" }));
    expect(result.passed).toBe(true);
  });
});

describe("L1 — timestamp window", () => {
  it("rejects an unparseable timestamp", async () => {
    const result = await run(validEnvelope({ timestamp: "not-a-date" }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "INVALID_TIMESTAMP")).toBe(true);
  });

  it("rejects a timestamp far in the future", async () => {
    // FROZEN_NOW + 1 hour vs default 5min skew
    const future = new Date(FROZEN_NOW.getTime() + 60 * 60 * 1000).toISOString();
    const result = await run(validEnvelope({ timestamp: future }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "TIMESTAMP_IN_FUTURE")).toBe(true);
  });

  it("accepts a timestamp slightly in the future (within NTP skew)", async () => {
    const future = new Date(FROZEN_NOW.getTime() + 2 * 60 * 1000).toISOString();
    const result = await run(validEnvelope({ timestamp: future }));
    expect(result.passed).toBe(true);
  });

  it("rejects a timestamp older than the configured window", async () => {
    const old = new Date(FROZEN_NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const result = await run(validEnvelope({ timestamp: old }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "TIMESTAMP_TOO_OLD")).toBe(true);
  });

  it("honors a custom maxPastSkewMs", async () => {
    // Tight 1-minute window — a 5-minute-old timestamp now fails.
    const fiveMinAgo = new Date(FROZEN_NOW.getTime() - 5 * 60 * 1000).toISOString();
    const tight = createInputValidationLayer({ now, maxPastSkewMs: 60 * 1000 });
    const result = await tight.run({
      submission_id: "00000000-0000-0000-0000-000000000001",
      payload: validEnvelope({ timestamp: fiveMinAgo }),
      previous_results: [],
    });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("TIMESTAMP_TOO_OLD");
  });
});

describe("L1 — payload", () => {
  it("rejects a non-object payload", async () => {
    const result = await run(validEnvelope({ payload: "not-an-object" }));
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "PAYLOAD_NOT_OBJECT")).toBe(true);
  });

  it("rejects geo.lat outside [-90, 90]", async () => {
    const env = validEnvelope({
      payload: { sensor_id: "x", detection_class: "fod", geo: { lat: 91, lng: 0 } },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "GEO_LAT_OUT_OF_RANGE")).toBe(true);
  });

  it("rejects geo.lng outside [-180, 180]", async () => {
    const env = validEnvelope({
      payload: { sensor_id: "x", detection_class: "fod", geo: { lat: 0, lng: 181 } },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "GEO_LNG_OUT_OF_RANGE")).toBe(true);
  });

  it("accepts edge coordinates exactly at the boundary", async () => {
    const env = validEnvelope({
      payload: {
        sensor_id: "x",
        detection_class: "fod",
        geo: { lat: -90, lng: 180 },
      },
    });
    const result = await run(env);
    expect(result.passed).toBe(true);
  });

  it("rejects a non-object geo without crashing", async () => {
    const env = validEnvelope({
      payload: { sensor_id: "x", detection_class: "fod", geo: "not-an-object" },
    });
    const result = await run(env);
    expect(result.passed).toBe(false);
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.some((f) => f.code === "GEO_NOT_OBJECT")).toBe(true);
  });
});

describe("L1 — error surface", () => {
  it("surfaces the FIRST failure as error_code (operator readability)", async () => {
    // Multiple failures; the layer result's top-level error_code is
    // the first one — the full list is in details.failures.
    const result = await run({
      // event_id, event_type, payload all wrong
      event_id: "not-a-uuid",
      event_type: "ai.detection.fod", // missing .emitted
      schema_version: "v1",
      source: { service: "x" },
      timestamp: "2026-05-29T09:59:30.000Z",
      payload: "not-an-object",
    });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("INVALID_UUID");
    const failures = (result.details?.failures as { code: string }[]) ?? [];
    expect(failures.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        "INVALID_UUID",
        "INVALID_AI_DETECTION_EVENT_TYPE",
        "PAYLOAD_NOT_OBJECT",
      ]),
    );
  });
});
