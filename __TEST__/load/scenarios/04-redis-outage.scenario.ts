/**
 * Scenario 04 — Redis outage + recovery.
 *
 * Stops the Redis container mid-flight, confirms the services don't die
 * (their HTTP /metrics surfaces are independent of Redis health), then
 * restarts Redis and proves ingestion resumes within the recovery
 * window. This is the "broker flaps" resilience property.
 *
 * Requires the docker CLI (to stop/start the container). If docker
 * isn't available the test self-skips rather than failing.
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
  serviceLive,
  sleep,
  thresholds,
  type LoadPublisher,
} from "../src/harness/index.js";
import { gatedDescribe } from "./_guard.js";

const describeStack = await gatedDescribe();
const T = thresholds.redisOutage;

describeStack("04 — redis outage + recovery", () => {
  let pub: LoadPublisher;
  let hasDocker = false;

  beforeAll(async () => {
    hasDocker = await dockerAvailable();
    pub = await connectLoadPublisher();
  });

  afterAll(async () => {
    pub?.disconnect();
    // Defensive: make sure we never leave Redis stopped.
    if (hasDocker) await fault.start(env.containers.redis).catch(() => {});
  });

  it("services survive the outage and ingestion recovers after Redis returns", async (ctx) => {
    if (!hasDocker) ctx.skip();

    // Stop Redis.
    await fault.stop(env.containers.redis);
    await sleep(1_000);

    // event-pipeline's HTTP surface is independent of Redis — it must
    // still answer /metrics even with the broker down.
    expect(await serviceLive("event-pipeline"), "event-pipeline died during Redis outage").toBe(
      true,
    );

    // Bring Redis back.
    await fault.start(env.containers.redis);

    // Wait for the pipeline's subscriber to reconnect, then drive a
    // fresh batch and confirm it gets processed.
    const recovered = await pollUntil(async () => serviceLive("event-pipeline"), {
      timeoutMs: T.recoverWithinMs,
      intervalMs: 1_000,
    });
    expect(recovered).toBeTruthy();
    await sleep(2_000); // let ioredis reconnect settle

    const base = await processedCount();
    const result = await driveAtRate(() => pub.publishFrame(), {
      total: T.framesAfterRecovery,
      ratePerSec: 100,
    });
    const target = base + result.acked * T.minProcessedFractionAfter;
    const caughtUp = await pollUntil(async () => (await processedCount()) >= target, {
      timeoutMs: T.recoverWithinMs,
      intervalMs: 1_000,
    });
    expect(caughtUp, "ingestion did not recover after Redis came back").toBeTruthy();
  });
});
