# Risk Scoring — Confidence Calibration

How the AI inference service turns raw detector confidence into a calibrated risk score that drives downstream routing and operator alerting.

## Intent

A calibrated score of `0.7` should reflect **~70% precision** when evaluated against the fixture-truth ground truth set in `data/seed/scenarios/`. Without calibration, individual detector confidences are arbitrary — `0.7` from the FOD head means something different than `0.7` from the wildlife head, and neither maps to "70% of detections at this score are true positives." Calibration is what makes them comparable.

## Pipeline

```
raw_confidence
  ↓ per-detector linear calibration:  c1 = slope * raw + intercept
  ↓ weather degradation modifier:     c2 = c1 * weather_factor(visibility_m)
  ↓ publish threshold:                drop if c2 < min_publish_threshold
final_confidence
```

The transform is applied in [`src/pipeline/runtime.py`](../../services/ai-inference/src/pipeline/runtime.py) between the orchestrator and the publisher. Detectors stay pure — they never see calibration parameters.

## Per-detector calibration

| Detector   | slope | intercept | min_publish | Why                                                                                                                           |
| ---------- | ----- | --------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `fod`      | 0.95  | 0.00      | 0.40        | Detector slightly over-confident on borderline FOD truth; narrowed slope keeps high-score boundary cases at ≈ 0.7 calibrated. |
| `crack`    | 1.00  | 0.05      | 0.35        | Linear crack types tend to under-shoot; small positive intercept lifts mid-range scores into the 0.6–0.8 band.                |
| `snowbank` | 1.00  | 0.00      | 0.50        | Measurements are deterministic from height + setback; identity calibration is the right answer.                               |
| `wildlife` | 1.00  | 0.00      | 0.40        | Truth-driven score on a small species set already calibrates well.                                                            |
| `anomaly`  | 1.00  | 0.00      | 0.00        | The low-confidence band IS the routing signal for HITL; threshold = 0 keeps everything in the review queue.                   |

These coefficients live in [`src/app.py::_default_calibrator`](../../services/ai-inference/src/app.py). Re-fitting after a fixture-set change happens manually and lands as a coefficient change there + a revision to this section in the same PR.

### Methodology (when re-fitting)

1. Run the full fixture set through the detector under test with calibration disabled (identity transform).
2. Bucket detections by raw confidence into 10 bands of width 0.1.
3. Compute precision per band (`true_positives / total`) against `fixture_truth`.
4. Fit `slope` and `intercept` so calibrated-score band centers approximate their precision.
5. Pick `min_publish_threshold` at the lowest band where precision ≥ 0.40 (operator-load floor).
6. Update the table above + the constants in `_default_calibrator()`.

The reviewer queue (T-403) sees rejected detections separately, so dropping by `min_publish_threshold` does NOT silently lose data — it just routes it differently.

## Weather degradation modifier

Defined in [`src/confidence/calibration.py::WeatherDegradation`](../../services/ai-inference/src/confidence/calibration.py). SOP thresholds load from [`data/seed/reference/sop-baseline.json`](../../data/seed/reference/sop-baseline.json):

```json
"weather": {
  "low_visibility_threshold_m": 800,
  "confidence_degradation_threshold_m": 1200
}
```

| Visibility       | Factor | Effect                                                     |
| ---------------- | ------ | ---------------------------------------------------------- |
| `≥ 1200 m`       | `1.00` | No modifier.                                               |
| `800 ≤ v < 1200` | `0.70` | Light degradation — detector confidence multiplied by 0.7. |
| `< 800 m`        | `0.50` | Hard low-visibility — confidence halved.                   |

Frames carry weather context in `payload.metadata.weather.visibility_m`. Missing or malformed values default to **no modifier** (`factor = 1.0`) — we don't penalize for missing data.

This modifier drives **scenario 06 (weather-degraded visibility)** in T-311's e2e suite: the same camera frame produces a `critical` FOD detection in clear conditions and a `medium` HITL-routed detection in fog, deterministically and without changing the detector code.

## Invariants

- **Calibration only DOWNGRADES.** The transform can never raise the published confidence above the raw value × 1.0 (slope ≤ 1.0 in defaults; weather factor ≤ 1.0).
- **Severity hint is detector-owned.** Calibration doesn't touch `severity_hint`. A detection that drops below `min_publish_threshold` is removed entirely; otherwise the detector's severity stays.
- **Calibration metadata is auditable.** Each calibrated detection carries `metadata.calibration` with the raw score, slope, intercept, weather factor, and final score — the reviewer queue and the audit trail can reproduce the transform exactly.

## Counters

`RuntimeCounters` (in [`runtime.py`](../../services/ai-inference/src/pipeline/runtime.py)) exposes:

- `detections_published` — survived calibration + published to Redis.
- `detections_dropped_by_calibration` — dropped below `min_publish_threshold`.

Both are surfaced via `/metrics` once T-502 lands.
