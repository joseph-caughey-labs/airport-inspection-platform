/**
 * Scenario 06 — AI service outage / timeout (failure isolation).
 *
 * The AI inference service sits OFF the sensor-ingestion hot path —
 * detections flow on a separate `ai.detection.*` channel consumed by a
 * dedicated bridge. So an AI outage must NOT degrade telemetry
 * ingestion. We take ai-inference down and prove sensor frames keep
 * being consumed at full fidelity: a fault in one subsystem stays
 * contained to that subsystem.
 *
 * (A true request/response AI timeout path isn't wired in this phase —
 * ai-inference is a stub — so the meaningful, real property to assert
 * is isolation, not a per-request timeout value.)
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  connectLoadPublisher,
  dockerAvailable,
  driveAtRate,
  env,
  fault,
  pollUntil,
  processedCount,
  sleep,
  thresholds,
  type LoadPublisher,
} from "../src/harness/index.js";
import { gatedDescribe } from "./_guard.js";

const describeStack = await gatedDescribe();
const T = thresholds.aiOutage;

describeStack("06 — AI service outage isolation", () => {
  let pub: LoadPublisher;
  let hasDocker = false;

  beforeAll(async () => {
    hasDocker = await dockerAvailable();
    pub = await connectLoadPublisher();
  });

  afterAll(async () => {
    pub?.disconnect();
    if (hasDocker) await fault.start(env.containers.aiInference).catch(() => {});
  });

  it("sensor ingestion is unaffected while ai-inference is down", async (ctx) => {
    if (!hasDocker) ctx.skip();

    await fault.stop(env.containers.aiInference);
    await sleep(1_000);

    const base = await processedCount();
    const result = await driveAtRate(() => pub.publishFrame(), {
      total: T.framesDuringOutage,
      ratePerSec: 150,
    });

    const target = base + result.acked * T.minProcessedFraction;
    const caughtUp = await pollUntil(async () => (await processedCount()) >= target, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    });
    expect(
      caughtUp,
      "AI outage leaked into the sensor ingestion path — failure was not isolated",
    ).toBeTruthy();

    await fault.start(env.containers.aiInference);
  });
});
