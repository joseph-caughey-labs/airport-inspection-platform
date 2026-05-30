/**
 * Layer 5 — Cross-System Consistency tests (T-409).
 *
 * Verifies that the relationships between the entities the
 * detection names are internally consistent — the sensor's
 * registered airport matches the payload's airport, the sensor
 * isn't registered as offline at capture time.
 */
import { describe, expect, it } from "vitest";
import { createCrossSystemLayer } from "../../../services/validation-engine/src/layers/05-cross-system/index.js";
import { InMemoryReferenceDataClient } from "../../../services/validation-engine/src/reference/client.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";
const AIRPORT_A = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const AIRPORT_B = "22222222-2222-2222-2222-bbbbbbbbbbbb";
const SENSOR = "CAM-N-03";

function envWith(payload: Record<string, unknown>): unknown {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "ai.detection.fod.emitted",
    schema_version: "v1",
    source: { service: "test" },
    timestamp: "2026-05-29T10:00:00.000Z",
    payload,
  };
}

async function run(payload: unknown, cfg: Parameters<typeof createCrossSystemLayer>[0] = {}) {
  return createCrossSystemLayer(cfg).run({
    submission_id: SUB_ID,
    payload,
    previous_results: [],
  });
}

describe("L5 — without a client", () => {
  it("passes through unconditionally", async () => {
    const result = await run(envWith({ sensor_id: SENSOR, airport_id: AIRPORT_A }));
    expect(result).toEqual({ layer: "05_cross_system", passed: true });
  });
});

describe("L5 — airport ↔ sensor consistency", () => {
  it("passes when payload airport matches the sensor's registered airport", async () => {
    const client = new InMemoryReferenceDataClient({
      sensors: [{ id: SENSOR, airport_id: AIRPORT_A, status: "online" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR, airport_id: AIRPORT_A }), { client });
    expect(result.passed).toBe(true);
  });

  it("fails SENSOR_AIRPORT_MISMATCH when payload airport ≠ sensor's airport", async () => {
    const client = new InMemoryReferenceDataClient({
      sensors: [{ id: SENSOR, airport_id: AIRPORT_A, status: "online" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR, airport_id: AIRPORT_B }), { client });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("SENSOR_AIRPORT_MISMATCH");
    const failure = (result.details?.failures as { expected: string; actual: string }[])[0]!;
    expect(failure.expected).toBe(AIRPORT_A);
    expect(failure.actual).toBe(AIRPORT_B);
  });

  it("skips the airport check when payload doesn't carry airport_id", async () => {
    const client = new InMemoryReferenceDataClient({
      sensors: [{ id: SENSOR, airport_id: AIRPORT_A, status: "online" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR }), { client });
    expect(result.passed).toBe(true);
  });
});

describe("L5 — sensor status", () => {
  it("passes for an `online` sensor", async () => {
    const client = new InMemoryReferenceDataClient({
      sensors: [{ id: SENSOR, airport_id: AIRPORT_A, status: "online" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR }), { client });
    expect(result.passed).toBe(true);
  });

  it("passes for a `degraded` sensor (detections still meaningful)", async () => {
    const client = new InMemoryReferenceDataClient({
      sensors: [{ id: SENSOR, airport_id: AIRPORT_A, status: "degraded" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR }), { client });
    expect(result.passed).toBe(true);
  });

  it("fails SENSOR_OFFLINE_AT_CAPTURE for an offline sensor", async () => {
    const client = new InMemoryReferenceDataClient({
      sensors: [{ id: SENSOR, airport_id: AIRPORT_A, status: "offline" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR }), { client });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("SENSOR_OFFLINE_AT_CAPTURE");
  });
});

describe("L5 — defers to L4 when entities are missing", () => {
  it("passes silently when the sensor isn't in reference-data (L4 owns that fail)", async () => {
    // Avoids double-failing the operator on the same issue.
    const client = new InMemoryReferenceDataClient({ sensors: [] });
    const result = await run(envWith({ sensor_id: SENSOR, airport_id: AIRPORT_A }), { client });
    expect(result.passed).toBe(true);
  });

  it("passes when payload has no sensor_id (nothing to cross-check)", async () => {
    const client = new InMemoryReferenceDataClient({});
    const result = await run(envWith({}), { client });
    expect(result.passed).toBe(true);
  });
});

describe("L5 — combined failures", () => {
  it("collects mismatch + offline into details.failures", async () => {
    const client = new InMemoryReferenceDataClient({
      sensors: [{ id: SENSOR, airport_id: AIRPORT_A, status: "offline" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR, airport_id: AIRPORT_B }), { client });
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes).toEqual(["SENSOR_AIRPORT_MISMATCH", "SENSOR_OFFLINE_AT_CAPTURE"]);
  });
});
