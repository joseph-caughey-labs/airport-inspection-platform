/**
 * Layer 4 — Source-of-Truth Cross-Check tests (T-409).
 *
 * Verifies the entities the detection names (sensor_id, optional
 * airport_id) actually exist in reference-data. The default
 * client-less factory path passes through — the layer is only
 * meaningful when wired against a real client.
 */
import { describe, expect, it } from "vitest";
import { createSourceOfTruthLayer } from "../../../services/validation-engine/src/layers/04-source-of-truth/index.js";
import { InMemoryReferenceDataClient } from "../../../services/validation-engine/src/reference/client.js";

const SUB_ID = "00000000-0000-0000-0000-000000000001";
const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const SENSOR = "CAM-N-03";

function clientWith(opts: Parameters<typeof InMemoryReferenceDataClient>[0] = {}) {
  return new InMemoryReferenceDataClient(opts);
}

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

async function run(payload: unknown, cfg: Parameters<typeof createSourceOfTruthLayer>[0] = {}) {
  return createSourceOfTruthLayer(cfg).run({
    submission_id: SUB_ID,
    payload,
    previous_results: [],
  });
}

describe("L4 — without a client", () => {
  it("passes through unconditionally when no client is configured", async () => {
    const result = await run(envWith({ sensor_id: "nonexistent-sensor" }));
    expect(result).toEqual({ layer: "04_source_of_truth", passed: true });
  });
});

describe("L4 — sensor lookup", () => {
  it("passes when the sensor exists in reference-data", async () => {
    const client = clientWith({
      sensors: [{ id: SENSOR, airport_id: AIRPORT, status: "online" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR }), { client });
    expect(result.passed).toBe(true);
  });

  it("fails SENSOR_NOT_FOUND when the sensor isn't registered", async () => {
    const client = clientWith({ sensors: [] });
    const result = await run(envWith({ sensor_id: SENSOR }), { client });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("SENSOR_NOT_FOUND");
    const failure = (result.details?.failures as { value: string }[])[0]!;
    expect(failure.value).toBe(SENSOR);
  });
});

describe("L4 — airport lookup", () => {
  it("passes when the airport exists", async () => {
    const client = clientWith({
      sensors: [{ id: SENSOR, airport_id: AIRPORT, status: "online" }],
      airports: [{ id: AIRPORT, iata_code: "JFK" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR, airport_id: AIRPORT }), { client });
    expect(result.passed).toBe(true);
  });

  it("fails AIRPORT_NOT_FOUND when airport_id is set but unknown", async () => {
    const client = clientWith({
      sensors: [{ id: SENSOR, airport_id: AIRPORT, status: "online" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR, airport_id: AIRPORT }), { client });
    expect(result.passed).toBe(false);
    expect(result.error_code).toBe("AIRPORT_NOT_FOUND");
  });

  it("doesn't fail when airport_id is absent (payload field is optional)", async () => {
    const client = clientWith({
      sensors: [{ id: SENSOR, airport_id: AIRPORT, status: "online" }],
    });
    const result = await run(envWith({ sensor_id: SENSOR }), { client });
    expect(result.passed).toBe(true);
  });
});

describe("L4 — combined failures", () => {
  it("collects both lookups into details.failures in one pass", async () => {
    const client = clientWith({ sensors: [], airports: [] });
    const result = await run(envWith({ sensor_id: SENSOR, airport_id: AIRPORT }), { client });
    expect(result.passed).toBe(false);
    const codes = ((result.details?.failures as { code: string }[]) ?? []).map((f) => f.code);
    expect(codes).toEqual(["SENSOR_NOT_FOUND", "AIRPORT_NOT_FOUND"]);
    // Top-level error_code is the FIRST failure for operator readability.
    expect(result.error_code).toBe("SENSOR_NOT_FOUND");
  });

  it("passes through when payload has no sensor_id or airport_id", async () => {
    const client = clientWith({});
    const result = await run(envWith({}), { client });
    expect(result.passed).toBe(true);
  });
});
