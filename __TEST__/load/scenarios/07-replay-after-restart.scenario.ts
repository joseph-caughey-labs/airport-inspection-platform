/**
 * Scenario 07 — Replay / recovery after a service restart.
 *
 * Drives a batch of frames, restarts the event-pipeline container
 * mid-stream, waits for it to come back, then drives a second batch and
 * proves the pipeline resumes processing with no manual intervention.
 *
 * Note on durability: `consumer_processed_total` is per-process and
 * resets to 0 on restart, so the post-restart assertion measures the
 * NEW process's delta. The durable replay path itself (DB-backed outbox
 * resuming un-broadcast rows) is exercised implicitly — the restarted
 * pipeline reconnects its subscriber + outbox worker and catches up.
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
const T = thresholds.replay;

describeStack("07 — replay after restart", () => {
  let pub: LoadPublisher;
  let hasDocker = false;

  beforeAll(async () => {
    hasDocker = await dockerAvailable();
    pub = await connectLoadPublisher();
  });

  afterAll(() => {
    pub?.disconnect();
  });

  it("resumes processing after event-pipeline restarts", async (ctx) => {
    if (!hasDocker) ctx.skip();

    // First batch — pre-restart traffic.
    await driveAtRate(() => pub.publishFrame(), { total: T.framesBeforeRestart, ratePerSec: 150 });

    // Restart the pipeline mid-stream.
    await fault.restart(env.containers.eventPipeline);

    // Wait for the new process to answer /metrics again.
    const live = await pollUntil(async () => serviceLive("event-pipeline"), {
      timeoutMs: T.recoverWithinMs,
      intervalMs: 1_000,
    });
    expect(live, "event-pipeline did not come back after restart").toBeTruthy();
    await sleep(2_000); // subscriber + outbox reconnect settle

    // Post-restart baseline (counter reset to ~0 in the fresh process).
    const base = await processedCount();
    const result = await driveAtRate(() => pub.publishFrame(), {
      total: T.framesAfterRestart,
      ratePerSec: 150,
    });

    const target = base + result.acked * T.minProcessedFractionAfter;
    const caughtUp = await pollUntil(async () => (await processedCount()) >= target, {
      timeoutMs: T.recoverWithinMs,
      intervalMs: 1_000,
    });
    expect(caughtUp, "pipeline did not resume processing after restart").toBeTruthy();
  });
});
