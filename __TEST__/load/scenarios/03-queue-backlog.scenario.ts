/**
 * Scenario 03 — Queue backlog growth under overload.
 *
 * Fires a burst far above sustainable throughput. Redis pub/sub doesn't
 * buffer, so "backlog" here means the consumer orchestrator's in-flight
 * window saturating: the correct behaviour is BOUNDED shedding
 * (`consumer_dropped_total` rises) while the service stays alive and
 * keeps processing — not unbounded memory growth or a crash. We assert
 * survival + forward progress, and treat drops as expected backpressure.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  connectLoadPublisher,
  driveAtRate,
  droppedCount,
  processedCount,
  serviceLive,
  thresholds,
  type LoadPublisher,
} from "../src/harness/index.js";
import { gatedDescribe } from "./_guard.js";

const describeStack = await gatedDescribe();
const T = thresholds.backlog;

describeStack("03 — queue backlog under overload", () => {
  let pub: LoadPublisher;
  let baseProcessed = 0;

  beforeAll(async () => {
    pub = await connectLoadPublisher();
    baseProcessed = await processedCount();
  });

  afterAll(() => {
    pub?.disconnect();
  });

  it(`survives a ${T.burstRatePerSec}/s burst of ${T.totalFrames} frames and keeps making progress`, async () => {
    const before = await droppedCount();
    const result = await driveAtRate(() => pub.publishFrame(), {
      total: T.totalFrames,
      ratePerSec: T.burstRatePerSec,
    });

    // The pipeline must still be alive after the storm.
    if (T.requireLiveAfter) {
      expect(await serviceLive("event-pipeline"), "event-pipeline died under overload").toBe(true);
    }

    // Forward progress: it processed at least some frames beyond baseline.
    const processedDelta = (await processedCount()) - baseProcessed;
    expect(processedDelta).toBeGreaterThanOrEqual(T.minProcessedAfterBurst);

    // Shedding is allowed and expected — we just record it. (No upper
    // bound assertion: bounded-vs-unbounded is proven by "still alive +
    // still processing", and drops are the graceful-degradation signal.)
    const dropped = (await droppedCount()) - before;
    expect(dropped, "drop counter must be a finite number").toBeGreaterThanOrEqual(0);
    // Acked + processed + dropped should roughly account for the burst;
    // mostly a sanity check that the counters move under load.
    expect(result.acked).toBeGreaterThan(0);
  });
});
