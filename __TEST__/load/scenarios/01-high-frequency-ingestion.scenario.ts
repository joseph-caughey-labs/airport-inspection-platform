/**
 * Scenario 01 — High-frequency telemetry ingestion.
 *
 * Drives a sustained stream of wire-valid sensor frames onto
 * `sensor.frame.captured` and proves the event-pipeline consumes
 * essentially all of them, drops none, and keeps error rate flat.
 * This is the baseline "can it keep up at the demo's sustainable rate"
 * test that scenarios 03–07 perturb.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  connectLoadPublisher,
  driveAtRate,
  pollUntil,
  processedCount,
  droppedCount,
  thresholds,
  type LoadPublisher,
} from "../src/harness/index.js";
import { gatedDescribe } from "./_guard.js";

const describeStack = await gatedDescribe();
const T = thresholds.ingestion;

describeStack("01 — high-frequency ingestion", () => {
  let pub: LoadPublisher;
  let baseProcessed = 0;
  let baseDropped = 0;

  beforeAll(async () => {
    pub = await connectLoadPublisher();
    baseProcessed = await processedCount();
    baseDropped = await droppedCount();
  });

  afterAll(() => {
    pub?.disconnect();
  });

  it(`consumes ≥${T.minProcessedFraction * 100}% of ${T.totalFrames} frames at ${T.targetRatePerSec}/s with zero drops`, async () => {
    const result = await driveAtRate(() => pub.publishFrame(), {
      total: T.totalFrames,
      ratePerSec: T.targetRatePerSec,
    });
    expect(result.acked).toBeGreaterThan(0);

    // Wait for the pipeline's processed counter to catch up to the
    // frames Redis acked. processed_total is monotonic; compare deltas.
    const target = baseProcessed + result.acked * T.minProcessedFraction;
    const caughtUp = await pollUntil(async () => (await processedCount()) >= target, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    });
    const finalProcessed = await processedCount();
    expect(
      caughtUp,
      `processed only ${finalProcessed - baseProcessed} of ${result.acked} acked frames`,
    ).toBeTruthy();

    const dropped = (await droppedCount()) - baseDropped;
    expect(dropped, "pipeline shed frames at a sustainable rate").toBeLessThanOrEqual(T.maxDropped);
  });
});
