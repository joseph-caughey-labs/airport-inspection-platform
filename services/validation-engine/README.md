# `validation-engine`

The Parity 10-layer validation pipeline. Architecture is locked by [ADR 0008](../../docs/adr/0008-parity-10-layer-validation.md). T-302 landed the scaffold (orchestrator + 10 stubbed layers). **T-405** (this PR) promoted the canonical contracts (`ValidationLayerId`, `ValidationLayerResult`, `ValidationRun`, `ValidationSubmissionRequest`) into `@aip/shared-contracts` so the bridge in `event-pipeline` and the operator dashboard can consume them; added the production short-circuit default (stops at first failing layer) and prom metrics. Real per-layer logic lands in T-406 → T-411.

## The 10 layers

| #   | Folder                | Lands in         | Purpose                                                                                |
| --- | --------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| 1   | `01-input/`           | **T-406 (live)** | Envelope shape, required fields, UUID + ISO-8601 format, timestamp window, geo bounds. |
| 2   | `02-schema/`          | T-407            | DTO/event schema conformance, versions, enums.                                         |
| 3   | `03-business-rules/`  | T-408            | Severity-by-location, SOP thresholds.                                                  |
| 4   | `04-source-of-truth/` | T-409            | Cross-check against `reference-data`.                                                  |
| 5   | `05-cross-system/`    | T-409            | Consistency across DB, cache, derived views.                                           |
| 6   | `06-ai-output/`       | T-410            | Bbox sanity, confidence ≥ threshold, evidence linkage.                                 |
| 7   | `07-risk/`            | T-410            | Named-factor risk score; threshold gating.                                             |
| 8   | `08-human-review/`    | T-411            | HITL routing; reviewer claim/decision.                                                 |
| 9   | `09-audit/`           | T-411            | Lineage emission.                                                                      |
| 10  | `10-certification/`   | T-411            | Final gate — all required layers passed or approved exception.                         |

### Layer 1 — Input Validation (live)

Configurable via `createInputValidationLayer({ now, maxFutureSkewMs, maxPastSkewMs })`. Defaults: future skew 5min (NTP tolerance), past skew 24h (anything older is replay traffic; T-415's replay queue is the right path for it). The layer collects ALL failures on a single pass — operators see every issue at once instead of fix-and-resubmit cycling. Failure codes:

| Code                                                               | When                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| `ENVELOPE_NOT_OBJECT`                                              | Envelope is not a non-array object.                  |
| `MISSING_FIELD`                                                    | A required top-level field is absent.                |
| `INVALID_UUID`                                                     | `event_id` is present but not a UUID.                |
| `EMPTY_EVENT_TYPE`                                                 | `event_type` is an empty string.                     |
| `INVALID_AI_DETECTION_EVENT_TYPE`                                  | Claims `ai.detection.*` but doesn't match the regex. |
| `INVALID_TIMESTAMP`                                                | `timestamp` doesn't parse as ISO-8601.               |
| `TIMESTAMP_IN_FUTURE`                                              | Beyond `maxFutureSkewMs` past `now`.                 |
| `TIMESTAMP_TOO_OLD`                                                | Older than `maxPastSkewMs`.                          |
| `PAYLOAD_NOT_OBJECT`                                               | `payload` is missing or not an object.               |
| `GEO_NOT_OBJECT` / `GEO_LAT_OUT_OF_RANGE` / `GEO_LNG_OUT_OF_RANGE` | `payload.geo` malformed or out of range.             |

## Endpoints

| Method | Path        | Returns                                         |
| ------ | ----------- | ----------------------------------------------- |
| GET    | `/health`   | 200 ok                                          |
| GET    | `/ready`    | 200 ready                                       |
| POST   | `/validate` | `{ run_id, layers: [...], certified: boolean }` |

`POST /validate` accepts `{ submission_id, payload }` and runs the configured layer list. The HTTP layer parses the body via `ValidationSubmissionRequest` from `@aip/shared-contracts`. Layer 1 (Input Validation) is live as of T-406 — production runs reject malformed envelopes before reaching L2. The remaining nine layers are still stubs returning `passed: true`; T-407+ replaces them with real per-domain logic.

Three Prometheus metrics are exposed on `GET /metrics`:

- `validation_layers_run_total{layer, passed}` — per-layer counter
- `validation_runs_total{certified}` — full-run outcome
- `validation_run_duration_seconds{certified}` — histogram

Production mode (`buildApp({ shortCircuit: true })`, the default) stops the orchestrator at the first failing layer; tests can pass `shortCircuit: false` to assert every stub layer's result.

## Layer contract

```ts
export interface ValidationLayer {
  id: ValidationLayerId;
  name: string;
  run(ctx: ValidationContext): Promise<ValidationLayerResult>;
}
```

Each layer is **pure** with respect to `ValidationContext`. The orchestrator owns ordering, short-circuit logic, and result aggregation.

## Configuration

| Var    | Default |
| ------ | ------- |
| `PORT` | `3009`  |
