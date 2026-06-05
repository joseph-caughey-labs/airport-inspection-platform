/**
 * SRE pass/fail thresholds for the load suite, in ONE place so the
 * scenarios stay declarative and the README can link to the source of
 * truth. These are demo-scale targets (single-host compose, not a
 * tuned cluster) — see README.md §Thresholds for the rationale and how
 * to retune for a real deployment.
 */
export const thresholds = {
  ingestion: {
    /** Target publish rate for the high-frequency scenario (frames/sec). */
    targetRatePerSec: 200,
    totalFrames: 2_000,
    /** ≥ this fraction of published frames must be consumed (processed_total delta). */
    minProcessedFraction: 0.99,
    /** event-pipeline must drop nothing at this sustainable rate. */
    maxDropped: 0,
  },
  wsFanout: {
    clients: 50,
    framesPublished: 20,
    /** Every connected client must receive ≥ this fraction of frames. */
    minDeliveryFraction: 0.95,
    /** All N clients must complete the upgrade. */
    requireAllConnected: true,
  },
  backlog: {
    /** A deliberate overload burst — well above sustainable throughput. */
    burstRatePerSec: 5_000,
    totalFrames: 20_000,
    /**
     * Under overload the pipeline must SHED (bounded `consumer_dropped`)
     * rather than grow unboundedly or crash. We assert it stayed alive
     * and kept processing — drops are allowed, a dead consumer is not.
     */
    minProcessedAfterBurst: 1,
    /** Service must still answer /metrics after the burst (liveness). */
    requireLiveAfter: true,
  },
  redisOutage: {
    /** After Redis returns, processing must resume within this window. */
    recoverWithinMs: 20_000,
    framesAfterRecovery: 200,
    minProcessedFractionAfter: 0.95,
  },
  dbLatency: {
    /** How long Postgres is frozen (pause) to simulate a latency spike. */
    freezeMs: 4_000,
    /** Edge + pipeline must stay alive (answer /metrics) during the freeze. */
    requireLiveDuringFreeze: true,
    /** After unpause, ingestion must recover. */
    framesAfterRecovery: 200,
    minProcessedFractionAfter: 0.95,
  },
  aiOutage: {
    /** With ai-inference down, sensor ingestion must be unaffected
     * (failure isolation — AI is not on the ingestion hot path). */
    framesDuringOutage: 500,
    minProcessedFraction: 0.99,
  },
  replay: {
    framesBeforeRestart: 500,
    framesAfterRestart: 500,
    /** After event-pipeline restarts, it must resume processing new
     * frames without manual intervention. */
    minProcessedFractionAfter: 0.95,
    recoverWithinMs: 30_000,
  },
} as const;
