"""Confidence calibration + weather degradation + fixture precision."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from src.confidence import (
    DEFAULT_DEGRADATION_FACTOR,
    DEFAULT_LOW_VISIBILITY_FACTOR,
    DEFAULT_WEATHER_DEGRADATION_M,
    DEFAULT_WEATHER_LOW_VISIBILITY_M,
    CalibrationConfig,
    Calibrator,
    WeatherDegradation,
    load_weather_degradation,
)
from src.models import DetectionPayload, GeoPoint


def _det(
    detection_class: str = "fod",
    confidence: float = 0.8,
    severity: str = "critical",
) -> DetectionPayload:
    return DetectionPayload(
        detection_id="d-1",
        sensor_id="CAM-1",
        frame_id="F-1",
        detection_class=detection_class,  # type: ignore[arg-type]
        confidence=confidence,
        severity_hint=severity,  # type: ignore[arg-type]
        captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        geo=GeoPoint(lat=37.62, lng=-122.37),
    )


# ── Per-detector linear calibration ──────────────────────────────────


def test_identity_calibration_preserves_confidence() -> None:
    cal = Calibrator()
    det = _det(confidence=0.65)
    out = cal.apply(det, {})
    assert out is not None
    assert out.confidence == pytest.approx(0.65)


def test_per_detector_slope_intercept_apply() -> None:
    cal = Calibrator(per_detector={"fod": CalibrationConfig(slope=0.5, intercept=0.1)})
    out = cal.apply(_det("fod", 0.8), {})
    assert out is not None
    assert out.confidence == pytest.approx(0.5 * 0.8 + 0.1)


def test_calibration_clamps_to_unit_interval() -> None:
    cal = Calibrator(per_detector={"fod": CalibrationConfig(slope=2.0, intercept=0.5)})
    out = cal.apply(_det("fod", 0.8), {})
    assert out is not None
    assert out.confidence == 1.0


def test_per_detector_min_publish_threshold_drops_below() -> None:
    cal = Calibrator(per_detector={"fod": CalibrationConfig(min_publish_threshold=0.5)})
    assert cal.apply(_det("fod", 0.4), {}) is None
    out = cal.apply(_det("fod", 0.6), {})
    assert out is not None
    assert out.confidence == pytest.approx(0.6)


def test_unknown_detector_class_uses_identity() -> None:
    cal = Calibrator(per_detector={"fod": CalibrationConfig(slope=2.0)})
    out = cal.apply(_det("crack", 0.5), {})
    assert out is not None
    assert out.confidence == pytest.approx(0.5)


# ── Weather degradation modifier ─────────────────────────────────────


@pytest.mark.parametrize(
    ("visibility_m", "expected_factor"),
    [
        (None, 1.0),
        (3000, 1.0),  # clear
        (1500, 1.0),  # above degradation threshold
        (1199, DEFAULT_DEGRADATION_FACTOR),  # within degradation band
        (1000, DEFAULT_DEGRADATION_FACTOR),
        (
            800,
            DEFAULT_DEGRADATION_FACTOR,
        ),  # boundary: equal to low threshold is still in degradation band
        (799, DEFAULT_LOW_VISIBILITY_FACTOR),  # one meter below → hard low band
        (500, DEFAULT_LOW_VISIBILITY_FACTOR),
        (0, DEFAULT_LOW_VISIBILITY_FACTOR),
    ],
)
def test_weather_factor_by_visibility(visibility_m: float | None, expected_factor: float) -> None:
    w = WeatherDegradation()
    assert w.factor_for(visibility_m) == pytest.approx(expected_factor)


def test_weather_factor_ignores_negative_visibility() -> None:
    w = WeatherDegradation()
    assert w.factor_for(-100) == 1.0


def test_weather_degradation_modifier_applied_to_calibrated_confidence() -> None:
    cal = Calibrator()
    out = cal.apply(_det("fod", 0.8), {"weather": {"visibility_m": 1000}})
    assert out is not None
    assert out.confidence == pytest.approx(0.8 * DEFAULT_DEGRADATION_FACTOR)


def test_weather_modifier_after_per_detector_calibration() -> None:
    """Order matters: per-detector calibration first, then weather modifier."""
    cal = Calibrator(per_detector={"fod": CalibrationConfig(slope=0.5)})
    # Raw 1.0 → slope 0.5 → 0.5 → weather 0.7 → 0.35
    out = cal.apply(_det("fod", 1.0), {"weather": {"visibility_m": 1000}})
    assert out is not None
    assert out.confidence == pytest.approx(0.5 * DEFAULT_DEGRADATION_FACTOR)


def test_weather_modifier_can_push_below_threshold_and_drop() -> None:
    cal = Calibrator(per_detector={"fod": CalibrationConfig(min_publish_threshold=0.5)})
    # Raw 0.7 calibrated stays 0.7; weather factor 0.5 → 0.35 → dropped.
    assert cal.apply(_det("fod", 0.7), {"weather": {"visibility_m": 500}}) is None


# ── Calibration metadata ─────────────────────────────────────────────


def test_calibration_metadata_recorded() -> None:
    cal = Calibrator(per_detector={"fod": CalibrationConfig(slope=0.9, intercept=0.05)})
    out = cal.apply(_det("fod", 0.7), {"weather": {"visibility_m": 1000}})
    assert out is not None
    meta = out.metadata["calibration"]
    assert meta["raw_confidence"] == pytest.approx(0.7)
    assert meta["slope"] == pytest.approx(0.9)
    assert meta["intercept"] == pytest.approx(0.05)
    assert meta["weather_factor"] == pytest.approx(DEFAULT_DEGRADATION_FACTOR)
    assert meta["final"] == pytest.approx(out.confidence)


def test_calibration_preserves_severity_hint() -> None:
    cal = Calibrator(per_detector={"fod": CalibrationConfig(slope=0.5)})
    out = cal.apply(_det("fod", 0.8, severity="critical"), {})
    assert out is not None
    assert out.severity_hint == "critical"


def test_calibration_preserves_existing_metadata() -> None:
    cal = Calibrator()
    det = _det("fod", 0.8)
    det = det.model_copy(update={"metadata": {"location": "runway"}})
    out = cal.apply(det, {})
    assert out is not None
    assert out.metadata["location"] == "runway"
    assert "calibration" in out.metadata


# ── Validation guards ────────────────────────────────────────────────


def test_calibration_config_rejects_invalid_slope() -> None:
    with pytest.raises(ValueError, match="slope"):
        CalibrationConfig(slope=0)
    with pytest.raises(ValueError, match="slope"):
        CalibrationConfig(slope=-0.1)


def test_calibration_config_rejects_invalid_threshold() -> None:
    with pytest.raises(ValueError, match="min_publish_threshold"):
        CalibrationConfig(min_publish_threshold=1.5)
    with pytest.raises(ValueError, match="min_publish_threshold"):
        CalibrationConfig(min_publish_threshold=-0.1)


def test_weather_degradation_rejects_inverted_thresholds() -> None:
    with pytest.raises(ValueError, match="greater than"):
        WeatherDegradation(low_visibility_threshold_m=1500, degradation_threshold_m=1000)


def test_weather_degradation_rejects_low_factor_above_high_factor() -> None:
    with pytest.raises(ValueError, match="low_visibility_factor"):
        WeatherDegradation(degradation_factor=0.5, low_visibility_factor=0.8)


def test_weather_degradation_rejects_zero_or_negative_factor() -> None:
    with pytest.raises(ValueError, match="degradation_factor"):
        WeatherDegradation(degradation_factor=0)
    with pytest.raises(ValueError, match="low_visibility_factor"):
        WeatherDegradation(low_visibility_factor=0)


# ── SOP loader ───────────────────────────────────────────────────────


def test_loader_pulls_thresholds_from_workspace_baseline() -> None:
    here = Path(__file__).resolve().parent.parent.parent
    sop_path = here / "data" / "seed" / "reference" / "sop-baseline.json"
    w = load_weather_degradation(sop_path)
    raw = json.loads(sop_path.read_text(encoding="utf-8"))
    assert w.low_visibility_threshold_m == raw["weather"]["low_visibility_threshold_m"]
    assert w.degradation_threshold_m == raw["weather"]["confidence_degradation_threshold_m"]


def test_loader_falls_back_for_missing_file(tmp_path: Path) -> None:
    w = load_weather_degradation(tmp_path / "missing.json")
    assert w.low_visibility_threshold_m == DEFAULT_WEATHER_LOW_VISIBILITY_M
    assert w.degradation_threshold_m == DEFAULT_WEATHER_DEGRADATION_M


def test_loader_repairs_inverted_thresholds(tmp_path: Path) -> None:
    p = tmp_path / "sop.json"
    p.write_text(
        json.dumps(
            {
                "weather": {
                    "low_visibility_threshold_m": 2000,
                    "confidence_degradation_threshold_m": 1000,
                }
            }
        )
    )
    w = load_weather_degradation(p)
    # Inverted → degradation threshold pushed above the low one.
    assert w.degradation_threshold_m > w.low_visibility_threshold_m


# ── AC: calibration on the fixture set (precision sanity check) ──────


def test_fod_calibration_keeps_high_score_fixtures_above_threshold() -> None:
    """AC: tests confirm calibration on fixture set. The conservative
    FOD slope (0.95) must keep a true-positive fixture at confidence
    0.88 (the FOD detector's base_confidence) above the 0.7 risk
    band so the operator alert still fires."""
    cal = Calibrator(
        per_detector={
            "fod": CalibrationConfig(slope=0.95, intercept=0.0, min_publish_threshold=0.4)
        }
    )
    out = cal.apply(_det("fod", 0.88), {})
    assert out is not None
    assert out.confidence >= 0.7


def test_crack_calibration_lifts_midrange_into_actionable_band() -> None:
    """Crack intercept of 0.05 should lift a 0.60 detection above
    0.65 — the band where the reviewer queue surfaces it."""
    cal = Calibrator(per_detector={"crack": CalibrationConfig(slope=1.0, intercept=0.05)})
    out = cal.apply(_det("crack", 0.60), {})
    assert out is not None
    assert out.confidence >= 0.65
