/**
 * Scenario 05 — Database latency / stall.
 *
 * Freezes the Postgres container (`docker pause`) to simulate an
 * extreme DB latency spike — queries hang rather than fail. The
 * platform must stay alive (HTTP surfaces keep answering) during the
 * stall, and ingestion must recover once the DB is unfrozen. Proves
 * persistence pressure degrades gracefully instead of cascading.
 *
 * Uses pause/unpause (not stop/start) so Postgres keeps its state and
 * connections, which is what a latency spike actually looks like.
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
const T = thresholds.dbLatency;

describeStack("05 — database latency spike", () => {
  let pub: LoadPublisher;
  let hasDocker = false;

  beforeAll(async () => {
    hasDocker = await dockerAvailable();
    pub = await connectLoadPublisher();
  });

  afterAll(async () => {
    pub?.disconnect();
    if (hasDocker) await fault.unpause(env.containers.postgres).catch(() => {});
  });

  it("stays alive during a DB freeze and recovers after", async (ctx) => {
    if (!hasDocker) ctx.skip();

    await fault.pause(env.containers.postgres);
    try {
      // During the freeze, drive a little load and confirm the edge +
      // pipeline HTTP surfaces still answer (no total lock-up).
      await sleep(500);
      void driveAtRate(() => pub.publishFrame(), { total: 100, ratePerSec: 100 }).catch(() => {});
      if (T.requireLiveDuringFreeze) {
        expect(await serviceLive("event-pipeline"), "pipeline locked up during DB freeze").toBe(
          true,
        );
        expect(await serviceLive("api-gateway"), "gateway locked up during DB freeze").toBe(true);
      }
      await sleep(T.freezeMs);
    } finally {
      await fault.unpause(env.containers.postgres);
    }

    // After unfreeze, ingestion must catch back up.
    await sleep(2_000);
    const base = await processedCount();
    const result = await driveAtRate(() => pub.publishFrame(), {
      total: T.framesAfterRecovery,
      ratePerSec: 100,
    });
    const target = base + result.acked * T.minProcessedFractionAfter;
    const caughtUp = await pollUntil(async () => (await processedCount()) >= target, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    });
    expect(caughtUp, "ingestion did not recover after DB unfreeze").toBeTruthy();
  });
});
