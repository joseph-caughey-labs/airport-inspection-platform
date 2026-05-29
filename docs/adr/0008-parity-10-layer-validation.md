# ADR 0008: Parity 10-Layer Validation Pipeline

- **Status**: Accepted
- **Date**: 2026-05-29
- **Owner**: Validation Engineer
- **Reviewers**: Domain Expert, Platform Architect

## Context

Operator dashboards in safety-critical domains can't rely on a single
"is this real?" check on each AI detection. A reasonable production
deployment runs ~10 independent validation stages — input format,
schema, business rules, source-of-truth cross-checks, AI output
sanity, risk scoring, optional human review, audit emission,
certification — each owning one failure mode. We need that staged
approach here for the same reason: a regression in any one of them
should be visible and recoverable without disabling the others.

T-302 landed the engine scaffold (orchestrator + 10 stubbed layers
returning `passed: true`). T-405 is the foundation pass that all the
real layer implementations (T-406+) will land on top of:

- The `ValidationLayerId` / `ValidationLayerResult` / `ValidationRun`
  shapes need to be consumable by the bridge in `event-pipeline` (so
  it can route certified=false to incident `reject`) and by the
  operator dashboard (so it can render the per-layer breakdown on
  the incident timeline).
- The orchestrator needs prom metrics on every layer + run so the
  oncall dashboard (T-502) can spot regressions after each fixture
  refresh.
- The orchestrator needs a production short-circuit default, so once
  L1 rejects a malformed payload we stop instead of running L2…L10
  against garbage.

## Decision

The 10 layers are the contract. Layer ids, layer ordering, and the
`ValidationRun` envelope live in `@aip/shared-contracts/validation`
as the single source of truth.

`runValidation()` short-circuits on the first failing layer by
default in production (`app.ts` passes `shortCircuit: true`); tests
can opt out to see every stub layer's result. The orchestrator emits
three Prometheus metrics:

- `validation_layers_run_total{layer, passed}` — per-layer pass/fail
- `validation_runs_total{certified}` — full-run outcome
- `validation_run_duration_seconds{certified}` — histogram

Real layer logic lands in T-406 (L1–L3) → T-411 (L9–L10). Each layer
is a pure function of `ValidationContext`; the orchestrator owns
ordering, short-circuit, and result aggregation. Layers MAY read
`previous_results` (L10 certification cares; L1 does not).

## Alternatives considered

- **One monolithic validator**: rejected — every failure mode would
  share blame. Operators couldn't tell whether a false positive came
  from a bbox sanity bug or a schema regression, and fixing one
  would risk regressing another.
- **Configurable layer list (yaml-driven)**: rejected — adds a config
  surface area we don't need yet. Adding/removing layers is an
  ADR-level decision (it changes the contract clients depend on),
  not a runtime toggle.
- **No short-circuit (always run all 10)**: rejected — wastes CPU on
  payloads already known bad, and pollutes the audit trail with
  cascading false failures (L1 rejects → L4 source-of-truth fails
  against missing data → noise in the operator UI).
- **Skip per-layer metrics, just aggregate run pass/fail**:
  rejected — a regression that flips L3 pass rate from 95% → 60%
  needs to be visible _as_ an L3 regression on the dashboard, not as
  generic "more rejections."

## Trade-offs

- **Lost**: Inability to add a new layer without (a) updating the
  zod enum in shared-contracts, (b) implementing it in the engine,
  and (c) bumping the ADR. This is a cost three consumers (engine,
  bridge, UI) pay together — they all need to know about the new
  layer.
- **Kept**: One canonical shape, three independent consumers; clear
  audit trail per layer; oncall dashboards stay accurate as layers
  evolve.

## Consequences

- T-406+ land one (or a few) layers at a time, each in a separate
  PR, each with its own per-domain payload zod schema inside the
  layer module. Adding a layer never requires touching the
  orchestrator — only registering it in `ORDERED_LAYERS`.
- The event-pipeline bridge (T-414 or earlier) needs to call
  `POST /validate` synchronously before posting to incident-service.
  We've explicitly accepted that latency in exchange for a hard
  consistency boundary between AI detection and incident creation.
- The operator dashboard (T-414) can render layer-by-layer status
  using only `ValidationLayerResult.layer` and `.passed` from the
  shared schema.

## Production evolution path

- **What stays**: the layer contract, the zod enum, the metrics
  shape. Bridge + UI keep working as the underlying layer
  implementations get more sophisticated.
- **What gets upgraded**: short-circuit semantics may grow a "must
  reach L9 audit even if L1 fails" override for compliance, gated
  behind a layer-id allow-list. Per-layer caching (L4 source-of-
  truth especially) becomes attractive at scale. Layer execution
  may move to a worker pool with a budget so a slow L6 can't queue
  L1 work.
- **What gets replaced**: the synchronous bridge call against
  `POST /validate` becomes a Redis stream + worker pool when sustained
  detection rates exceed the engine's per-request throughput.
