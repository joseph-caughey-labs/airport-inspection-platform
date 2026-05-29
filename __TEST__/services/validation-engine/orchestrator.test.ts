import { createRegistry } from "@aip/metrics";
import { describe, expect, it } from "vitest";
import {
  createOrchestratorMetrics,
  runValidation,
} from "../../../services/validation-engine/src/orchestrator/index.js";
import {
  ORDERED_LAYERS,
  type ValidationLayer,
} from "../../../services/validation-engine/src/layers/index.js";

describe("runValidation — stub layers", () => {
  it("runs all 10 layers in order", async () => {
    const run = await runValidation({});
    expect(run.layers).toHaveLength(10);
    const ids = run.layers.map((l) => l.layer);
    expect(ids).toEqual([
      "01_input",
      "02_schema",
      "03_business_rules",
      "04_source_of_truth",
      "05_cross_system",
      "06_ai_output",
      "07_risk",
      "08_human_review",
      "09_audit",
      "10_certification",
    ]);
  });

  it("returns certified: true when every layer passes", async () => {
    const run = await runValidation({});
    expect(run.certified).toBe(true);
    expect(run.layers.every((l) => l.passed)).toBe(true);
  });

  it("populates run_id, submission_id, and ISO timestamps", async () => {
    const run = await runValidation({});
    expect(run.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.submission_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.started_at).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(run.finished_at).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("preserves caller-supplied submission_id", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const run = await runValidation({}, { submission_id: id });
    expect(run.submission_id).toBe(id);
  });

  it("threads previous_results to each subsequent layer", async () => {
    const seen: number[] = [];
    const probe: ValidationLayer[] = ORDERED_LAYERS.map((layer, idx) => ({
      ...layer,
      async run(ctx) {
        seen.push(ctx.previous_results.length);
        return layer.run(ctx);
      },
    }));
    await runValidation({}, { layers: probe });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("runValidation — short-circuit", () => {
  it("with shortCircuit=true, stops after a failing layer", async () => {
    const failingLayer: ValidationLayer = {
      id: "03_business_rules",
      name: "fail-here",
      async run() {
        return {
          layer: "03_business_rules",
          passed: false,
          error_code: "boom",
        };
      },
    };
    const layers = [
      ORDERED_LAYERS[0]!,
      ORDERED_LAYERS[1]!,
      failingLayer,
      ORDERED_LAYERS[3]!,
      ORDERED_LAYERS[4]!,
    ];
    const run = await runValidation({}, { layers, shortCircuit: true });
    expect(run.layers).toHaveLength(3);
    expect(run.certified).toBe(false);
  });

  it("without shortCircuit, every layer runs even after a failure", async () => {
    const failingLayer: ValidationLayer = {
      id: "01_input",
      name: "fail-first",
      async run() {
        return { layer: "01_input", passed: false };
      },
    };
    const layers = [failingLayer, ...ORDERED_LAYERS.slice(1)];
    const run = await runValidation({}, { layers });
    expect(run.layers).toHaveLength(10);
    expect(run.certified).toBe(false);
  });
});

describe("runValidation — metrics", () => {
  function reg() {
    return createRegistry({ service: "orch-metrics-test", collectDefault: false });
  }

  it("counts each layer with its pass/fail status", async () => {
    const registry = reg();
    const metrics = createOrchestratorMetrics(registry);
    const failingLayer: ValidationLayer = {
      id: "03_business_rules",
      name: "fail",
      async run() {
        return { layer: "03_business_rules", passed: false };
      },
    };
    const layers = [ORDERED_LAYERS[0]!, ORDERED_LAYERS[1]!, failingLayer];
    await runValidation({}, { layers, metrics });
    const text = await registry.metrics();
    expect(text).toMatch(
      /validation_layers_run_total\{[^}]*layer="01_input"[^}]*passed="true"[^}]*\}\s+1/,
    );
    expect(text).toMatch(
      /validation_layers_run_total\{[^}]*layer="03_business_rules"[^}]*passed="false"[^}]*\}\s+1/,
    );
  });

  it("counts certified=false on the run counter when any layer fails", async () => {
    const registry = reg();
    const metrics = createOrchestratorMetrics(registry);
    const failingLayer: ValidationLayer = {
      id: "01_input",
      name: "fail-first",
      async run() {
        return { layer: "01_input", passed: false };
      },
    };
    await runValidation({}, { layers: [failingLayer], metrics });
    const text = await registry.metrics();
    expect(text).toMatch(/validation_runs_total\{[^}]*certified="false"[^}]*\}\s+1/);
  });

  it("observes a sample on validation_run_duration_seconds", async () => {
    const registry = reg();
    const metrics = createOrchestratorMetrics(registry);
    await runValidation({}, { metrics });
    const text = await registry.metrics();
    // _count and _sum are emitted by histograms; at least one sample
    // should be there with certified=true.
    expect(text).toMatch(/validation_run_duration_seconds_count\{[^}]*certified="true"[^}]*\}\s+1/);
  });

  it("short-circuit failure still records the run + the failed layer", async () => {
    const registry = reg();
    const metrics = createOrchestratorMetrics(registry);
    const failingLayer: ValidationLayer = {
      id: "01_input",
      name: "fail-first",
      async run() {
        return { layer: "01_input", passed: false };
      },
    };
    await runValidation(
      {},
      { layers: [failingLayer, ORDERED_LAYERS[1]!], metrics, shortCircuit: true },
    );
    const text = await registry.metrics();
    // L1 ran + failed; L2 was short-circuited away and must NOT have
    // a counter row.
    expect(text).toMatch(
      /validation_layers_run_total\{[^}]*layer="01_input"[^}]*passed="false"[^}]*\}\s+1/,
    );
    expect(text).not.toMatch(/validation_layers_run_total\{[^}]*layer="02_schema"/);
  });
});
