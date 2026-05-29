/**
 * Canonical contracts for the Parity 10-layer validation engine.
 *
 * Lifted out of `services/validation-engine/src/layers/types.ts` in
 * T-405 because:
 *
 *   1. The bridge in `event-pipeline` (T-310+) needs to type the
 *      validation submissions it sends + the results it receives back.
 *   2. The incident-service (T-405+) needs to consume `ValidationRun`
 *      results to drive a `reject` transition on certified=false.
 *   3. The operator dashboard (T-414) renders the per-layer breakdown
 *      on the incident detail timeline.
 *
 * All three consumers should depend on one schema source, not three
 * hand-maintained mirrors. This file is that source.
 */
export * from "./layer.js";
export * from "./run.js";
export * from "./submission.js";
