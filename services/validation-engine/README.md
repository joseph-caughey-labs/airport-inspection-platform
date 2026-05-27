# `validation-engine`

The Parity 10-layer validation pipeline. This PR lands the **scaffold**: an `orchestrator` that runs the 10 layers in order, each layer as an isolated module with a stub returning `{ passed: true }`. Real layer logic arrives in Phase 4 (T-405 → T-411).

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

`POST /validate` accepts `{ submission_id, payload }` and runs all 10 layers in order. With every layer stubbed to `passed: true`, the response is always `certified: true`; once T-405..T-411 land, real failures + short-circuit logic engage.

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
