# ADR 0004: AI inference simulation strategy

- **Status**: Accepted
- **Date**: 2026-06-05
- **Owner**: AI/ML Engineer
- **Reviewers**: Principal Architect, Validation Engineer

## Context

The platform's premise is "AI-assisted airport inspection," but the demo has no GPU, no trained model, and no labelled airfield imagery. We still need an inference tier that behaves like the real thing from every neighbouring service's point of view: it consumes sensor frames, emits detections with calibrated confidence, exhibits the operational characteristics that downstream code must handle (batching latency, low-confidence noise, weather degradation), and — critically for a demo and a test suite — produces **reproducible** output so a scenario walkthrough hits the same beats every run.

The tier also has to be a believable seam for the validation pipeline (ADR 0008) and HITL routing (ADR 0009): those layers are only interesting if the detections flowing into them carry realistic confidence distributions and class/severity variety, not a constant `confidence: 1.0`.

A secondary constraint shapes the implementation language: the rest of the platform is TypeScript, but real ML inference lives in Python. Modelling the service in Python keeps the boundary honest — the wire contract (Redis channels + JSON envelopes), not a shared in-process type, is what couples it to the Node services.

## Decision

`ai-inference` is a standalone **Python** service that simulates a model server. It subscribes to `sensor.frame.captured`, runs a set of per-class detectors, and publishes `ai.detection.<class>.emitted` envelopes that the event-pipeline bridge fans into the broadcast + validation paths.

The simulation is built around four production-shaped properties:

- **Determinism by seed.** A single `AI_SEED` propagates into every detector's RNG (`RuntimeConfig.seed`). Same seed + same frame stream → identical detections, every run. This is what makes demos rehearsable and the e2e/load scenarios assertable.
- **Calibrated, degradable confidence.** Raw detector scores pass through a `Calibrator` (weather degradation) and a `min_publish_threshold` before emission, so confidence is a distribution, not a constant — and degrades under simulated poor visibility (this is what the "weather-degraded LOW CONF" scenario exercises).
- **Temporal smoothing.** A `TemporalSmoother` (`window_size=5`, `threshold=3`) requires a `(sensor_id, detection_class)` to fire in 3 of the last 5 frames before it's allowed to publish, suppressing single-frame flicker the way a real tracker would.
- **Batch inference.** An optional `BatchScheduler` (`AI_BATCHING_ENABLED`, `batch_size=8`, `batch_timeout_ms=200`) flushes on size **or** timeout, mirroring how a real GPU server amortizes cost across a batch — and the batch latency it introduces is exactly the kind of thing the downstream timeout/isolation handling must tolerate. Disabled by default so the per-frame path stays simple for local dev.

Detection classes are a closed enum in `@aip/shared-contracts` (`fod`, `pavement_crack`, `snowbank_violation`, `wildlife`, `surface_anomaly`); adding one is an ADR-worthy change because it implies new validation rules and a new severity mapping.

## Alternatives considered

- **A real model (e.g. YOLO on sample imagery)**: rejected — no labelled airfield dataset, no GPU in the demo budget, and non-determinism would make scenarios and tests flaky. The point is to demonstrate the _system around_ inference, not the model.
- **A trivial random emitter in the Node event-pipeline**: rejected — collapses the language/process boundary that makes the architecture honest, and can't exhibit batching/calibration/smoothing, which are the operationally interesting behaviours downstream code exists to handle.
- **A canned, replayed detection log**: rejected — perfectly reproducible but inert; it can't react to live `AI_SEED`, weather inputs, or frame rate, so it couldn't drive the LOW CONF or batch-latency scenarios.

## Trade-offs

- **Lost**: any claim to real detection accuracy; the model's "intelligence" is scripted heuristics + RNG, not learned. The confidence numbers are plausible, not earned.
- **Lost**: the contract drift risk of a cross-language boundary — the TS `DetectionClass` enum and the Python publisher's wire strings can diverge (a known issue tracked separately); validation mirrors the wire format to stay safe.
- **Kept**: reproducibility, realistic confidence distributions, weather/temporal/batch behaviours, and a genuine Python-vs-Node process boundary — everything a reviewer needs to see that the _platform_ handles real inference operationally.

## Consequences

- Downstream code must treat AI output as a **separate, untrusted channel**: the event-pipeline bridge fires-and-forgets (`void handle().catch()`) so a slow/failed detection insert never stalls sensor ingestion (see [FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) mode 2; [ADR 0007](0007-edge-cloud-separation.md) draws the same seam).
- The validation pipeline (ADR 0008) and HITL thresholds (ADR 0009) can be tuned against a stable, seed-controlled confidence distribution.
- Every scenario that depends on AI output (FOD-on-runway, weather-degraded LOW CONF) is rehearsable by pinning `AI_SEED`.

## Production evolution path

The wire contract is the invariant — a real deployment swaps the service body, not its neighbours. The simulated detectors become a real model served by Triton / TorchServe (the `BatchScheduler` maps directly onto the server's dynamic batching); the `Calibrator` becomes a fitted temperature-scaling / Platt calibration on validation data; `TemporalSmoother` becomes a real multi-object tracker (SORT/ByteTrack). `AI_SEED`-driven determinism is replaced by model versioning + a golden-frame regression set. Because everyone speaks to it over `sensor.frame.captured` → `ai.detection.*.emitted`, none of event-pipeline, validation-engine, or the dashboard changes.
