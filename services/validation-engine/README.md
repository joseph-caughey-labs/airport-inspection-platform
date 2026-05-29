# `validation-engine`

The Parity 10-layer validation pipeline. Architecture is locked by [ADR 0008](../../docs/adr/0008-parity-10-layer-validation.md). T-302 landed the scaffold (orchestrator + 10 stubbed layers). **T-405** (this PR) promoted the canonical contracts (`ValidationLayerId`, `ValidationLayerResult`, `ValidationRun`, `ValidationSubmissionRequest`) into `@aip/shared-contracts` so the bridge in `event-pipeline` and the operator dashboard can consume them; added the production short-circuit default (stops at first failing layer) and prom metrics. Real per-layer logic lands in T-406 → T-411.

## The 10 layers

| #   | Folder                | Lands in | Purpose                                                                  |
| --- | --------------------- | -------- | ------------------------------------------------------------------------ |
| 1   | `01-input/`           | T-406    | Required fields, format, file integrity, timestamp validity, geo bounds. |
| 2   | `02-schema/`          | T-406    | DTO/event schema conformance, versions, enums.                           |
| 3   | `03-business-rules/`  | T-406    | Severity-by-location, SOP thresholds.                                    |
| 4   | `04-source-of-truth/` | T-407    | Cross-check against `reference-data`.                                    |
| 5   | `05-cross-system/`    | T-407    | Consistency across DB, cache, derived views.                             |
| 6   | `06-ai-output/`       | T-408    | Bbox sanity, confidence ≥ threshold, evidence linkage.                   |
| 7   | `07-risk/`            | T-408    | Named-factor risk score; threshold gating.                               |
| 8   | `08-human-review/`    | T-409    | HITL routing; reviewer claim/decision.                                   |
| 9   | `09-audit/`           | T-411    | Lineage emission.                                                        |
| 10  | `10-certification/`   | T-411    | Final gate — all required layers passed or approved exception.           |

## Endpoints

| Method | Path        | Returns                                         |
| ------ | ----------- | ----------------------------------------------- |
| GET    | `/health`   | 200 ok                                          |
| GET    | `/ready`    | 200 ready                                       |
| POST   | `/validate` | `{ run_id, layers: [...], certified: boolean }` |

`POST /validate` accepts `{ submission_id, payload }` and runs the configured layer list. The HTTP layer parses the body via `ValidationSubmissionRequest` from `@aip/shared-contracts`. With every layer stubbed `passed: true` the response is always `certified: true`; T-406+ replaces the stubs with real per-domain logic.

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
