# `validation-engine`

The Parity 10-layer validation pipeline. Architecture is locked by [ADR 0008](../../docs/adr/0008-parity-10-layer-validation.md). T-302 landed the scaffold (orchestrator + 10 stubbed layers). **T-405** (this PR) promoted the canonical contracts (`ValidationLayerId`, `ValidationLayerResult`, `ValidationRun`, `ValidationSubmissionRequest`) into `@aip/shared-contracts` so the bridge in `event-pipeline` and the operator dashboard can consume them; added the production short-circuit default (stops at first failing layer) and prom metrics. Real per-layer logic lands in T-406 → T-411.

## The 10 layers

| #   | Folder                | Lands in         | Purpose                                                                                                        |
| --- | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | `01-input/`           | **T-406 (live)** | Envelope shape, required fields, UUID + ISO-8601 format, timestamp window, geo bounds.                         |
| 2   | `02-schema/`          | **T-407 (live)** | DTO/event schema conformance (zod), `schema_version` allowlist, event-type-specific payload schemas.           |
| 3   | `03-business-rules/`  | **T-408 (live)** | SOP-driven policy: severity-by-location, dimension/width/setback thresholds, high-risk species severity floor. |
| 4   | `04-source-of-truth/` | **T-409 (live)** | Reference-data lookup: sensor + airport must exist.                                                            |
| 5   | `05-cross-system/`    | **T-409 (live)** | Cross-check: payload airport matches sensor's registered airport; sensor isn't `offline` at capture time.      |
| 6   | `06-ai-output/`       | T-410            | Bbox sanity, confidence ≥ threshold, evidence linkage.                                                         |
| 7   | `07-risk/`            | T-410            | Named-factor risk score; threshold gating.                                                                     |
| 8   | `08-human-review/`    | T-411            | HITL routing; reviewer claim/decision.                                                                         |
| 9   | `09-audit/`           | T-411            | Lineage emission.                                                                                              |
| 10  | `10-certification/`   | T-411            | Final gate — all required layers passed or approved exception.                                                 |

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

### Layer 2 — Schema & Contract Validation (live)

Configurable via `createSchemaValidationLayer({ supportedSchemaVersions })`. Default `["v1"]`. L2 runs three checks in one pass and surfaces every failure in `details.failures`:

1. **Envelope zod parse** against `EventEnvelope` from `@aip/shared-contracts` (catches `schema_version` regex, `source.service` presence, `idempotency_key` length, etc.). Failures get code prefix `ENVELOPE_SCHEMA__`.
2. **`schema_version` allowlist.** A publisher that forward-bumps without a corresponding engine release fails fast with `UNSUPPORTED_SCHEMA_VERSION` rather than confusing payload-schema failures further down.
3. **Payload schema by `event_type`**:
   - `sensor.frame.captured` → `SensorFramePayload` (from shared-contracts)
   - `ai.detection.<class>.emitted` → `AiDetectionPayload` (local wire-format schema in `02-schema/payload-schemas.ts` — see note below)
   - anything else → `UNSUPPORTED_EVENT_TYPE`

Payload failures carry `AI_DETECTION_PAYLOAD__<zod_code>` or `SENSOR_FRAME_PAYLOAD__<zod_code>` so dashboards can group regressions per event family.

**Note on the AI detection wire schema.** The TS `DetectionClass` enum in `@aip/shared-contracts/enums` uses long names (`pavement_crack`, `snowbank_violation`, `surface_anomaly`) but the Python AI publisher emits the short names (`crack`, `snowbank`, `anomaly`). L2 validates the wire format that actually flows, so the validator-side schema mirrors the publisher in `services/ai-inference/src/models/events.py`. Reconciling the TS enum with the wire format is its own ticket.

### Layer 3 — Business Rules (live)

SOP-driven policy. Configurable via `createBusinessRulesLayer({ thresholds })` (deep-partial override on top of the defaults in `03-business-rules/sop-thresholds.ts`, which mirror `data/seed/reference/sop-baseline.json`). Rules only fire when the relevant metadata field is present — L3 is policy, not schema (that's L2's job).

| Detector class | Rule                                                                           | Failure code                          |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `fod`          | `metadata.object_dimension_cm ≥ 2`                                             | `FOD_BELOW_MIN_DIMENSION`             |
| `fod`          | severity matches SOP severity-by-location for `metadata.location_category`     | `FOD_LOCATION_SEVERITY_MISMATCH`      |
| `crack`        | severity matches the SOP band for `metadata.crack_width_mm`                    | `CRACK_SEVERITY_BAND_MISMATCH`        |
| `snowbank`     | `metadata.snowbank_height_cm ≤ 240`                                            | `SNOWBANK_HEIGHT_OVER_MAX`            |
| `snowbank`     | `metadata.setback_m ≥` runway/taxiway minimum based on `metadata.surface_kind` | `SNOWBANK_SETBACK_BELOW_MIN`          |
| `wildlife`     | severity ≥ `high` when `metadata.species ∈ wildlife.highRiskClasses`           | `WILDLIFE_HIGH_RISK_SEVERITY_TOO_LOW` |

Sensor frame events and `anomaly` detections pass L3 unconditionally (no SOP-driven rules apply). All failures are collected into `details.failures` in a single pass; top-level `error_code` is the first failure.

### Layers 4 + 5 — Source-of-Truth and Cross-System (live)

L4 and L5 are the first I/O-touching layers — they take a `ReferenceDataClient` via factory config. The default `ORDERED_LAYERS` path uses no client, so both layers pass through; the engine stays usable in tests + bootstrap without a reference-data dependency. Production wiring in `app.ts` passes a real client.

**L4 — `createSourceOfTruthLayer({ client })`**

| Rule                                                                | Failure code        |
| ------------------------------------------------------------------- | ------------------- |
| `payload.sensor_id` must resolve via `getSensorById`                | `SENSOR_NOT_FOUND`  |
| `payload.airport_id` (if present) must resolve via `getAirportById` | `AIRPORT_NOT_FOUND` |

**L5 — `createCrossSystemLayer({ client })`**

| Rule                                                               | Failure code                |
| ------------------------------------------------------------------ | --------------------------- |
| `payload.airport_id` (if present) equals the sensor's `airport_id` | `SENSOR_AIRPORT_MISMATCH`   |
| Sensor's `status` is not `offline`                                 | `SENSOR_OFFLINE_AT_CAPTURE` |

L5 defers to L4 on missing entities — when `getSensorById` returns null, L5 passes silently to avoid double-failing the operator on the same issue.

Test helper: `InMemoryReferenceDataClient({ sensors, airports })` lives in `src/reference/client.ts` and is the seed for the unit tests. A `RestReferenceDataClient` that points at the running `reference-data` service is intentionally deferred to a later ticket — the engine ↔ reference-data wiring (timeouts, retries, caching) is its own concern; the layers stay testable via the interface alone.

## Endpoints

| Method | Path        | Returns                                         |
| ------ | ----------- | ----------------------------------------------- |
| GET    | `/health`   | 200 ok                                          |
| GET    | `/ready`    | 200 ready                                       |
| POST   | `/validate` | `{ run_id, layers: [...], certified: boolean }` |

`POST /validate` accepts `{ submission_id, payload }` and runs the configured layer list. The HTTP layer parses the body via `ValidationSubmissionRequest` from `@aip/shared-contracts`. L1 → L5 are live (T-406 → T-409). The remaining layers (L6 → L10) are stubs returning `passed: true`; T-410 + T-411 replace them with real per-domain logic.

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
