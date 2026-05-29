"""Snowbank compliance detector — SOP-driven."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from src.detectors import SnowbankDetector, load_snowbank_thresholds
from src.detectors.snowbank import DEFAULT_SOP_THRESHOLDS
from src.models import EventSource, GeoPoint, SensorFrameEvent, SensorFramePayload


def _frame(metadata: dict[str, Any] | None = None, frame_id: str = "F-1") -> SensorFrameEvent:
    return SensorFrameEvent(
        event_id=f"e-{frame_id}",
        schema_version="v1",
        source=EventSource(service="sensor-gateway"),
        timestamp=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        payload=SensorFramePayload(
            sensor_id="CAM-RWY10L-01",
            sensor_type="camera",
            frame_id=frame_id,
            captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
            geo=GeoPoint(lat=37.62, lng=-122.37),
            metadata=metadata or {},
        ),
    )


def _truth(
    location_class: str = "runway",
    height_cm: float | None = 100.0,
    setback_m: float | None = 10.0,
    bbox: dict[str, float] | None = None,
    base_confidence: float | None = None,
) -> dict[str, Any]:
    snow: dict[str, Any] = {
        "present": True,
        "location_class": location_class,
    }
    if height_cm is not None:
        snow["height_cm"] = height_cm
    if setback_m is not None:
        snow["setback_m"] = setback_m
    if bbox is not None:
        snow["bbox"] = bbox
    if base_confidence is not None:
        snow["base_confidence"] = base_confidence
    return {"fixture_truth": {"snowbank": snow}}


# ── Compliance + violation classification ────────────────────────────


@pytest.mark.asyncio
async def test_compliant_snowbank_emits_no_detection() -> None:
    """AC: Compliant snowbanks → no flag."""
    det = SnowbankDetector(seed=0)
    out = await det.detect(
        _frame(metadata=_truth(location_class="runway", height_cm=200, setback_m=10))
    )
    assert out == []


@pytest.mark.asyncio
async def test_height_violation_flagged_alone() -> None:
    """AC: Non-compliant (height OR setback) → flagged with specific violation."""
    det = SnowbankDetector(seed=0)
    out = await det.detect(
        _frame(metadata=_truth(location_class="runway", height_cm=300, setback_m=10))
    )
    assert len(out) == 1
    assert out[0].metadata["violations"] == ["height_exceeded"]


@pytest.mark.asyncio
async def test_runway_setback_violation_flagged_alone() -> None:
    det = SnowbankDetector(seed=0)
    out = await det.detect(
        _frame(metadata=_truth(location_class="runway", height_cm=200, setback_m=4))
    )
    assert out[0].metadata["violations"] == ["setback_runway"]


@pytest.mark.asyncio
async def test_taxiway_setback_violation_flagged_alone() -> None:
    det = SnowbankDetector(seed=0)
    out = await det.detect(
        _frame(metadata=_truth(location_class="taxiway", height_cm=200, setback_m=2))
    )
    assert out[0].metadata["violations"] == ["setback_taxiway"]


@pytest.mark.asyncio
async def test_combined_height_and_setback_violations_both_listed() -> None:
    det = SnowbankDetector(seed=0)
    out = await det.detect(
        _frame(metadata=_truth(location_class="runway", height_cm=300, setback_m=4))
    )
    assert set(out[0].metadata["violations"]) == {"height_exceeded", "setback_runway"}


@pytest.mark.asyncio
async def test_unknown_location_uses_strictest_setback_threshold() -> None:
    """A mislabeled location is rated against the strictest threshold
    so a typo never silently rates a violation as compliant."""
    det = SnowbankDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(location_class="hangar", setback_m=4)))
    assert out[0].metadata["violations"] == ["setback_unknown_location"]


@pytest.mark.asyncio
async def test_runway_setback_exactly_at_threshold_is_compliant() -> None:
    det = SnowbankDetector(seed=0)
    out = await det.detect(
        _frame(metadata=_truth(location_class="runway", height_cm=240, setback_m=6))
    )
    assert out == []


# ── Severity hint by location ────────────────────────────────────────


@pytest.mark.asyncio
async def test_severity_matches_location() -> None:
    det = SnowbankDetector(seed=0)
    rwy = (await det.detect(_frame(metadata=_truth(location_class="runway", height_cm=300))))[0]
    twy = (await det.detect(_frame(metadata=_truth(location_class="taxiway", height_cm=300))))[0]
    apn = (await det.detect(_frame(metadata=_truth(location_class="apron", height_cm=300))))[0]
    assert rwy.severity_hint == "critical"
    assert twy.severity_hint == "high"
    assert apn.severity_hint == "medium"


# ── Threshold loader ─────────────────────────────────────────────────


def test_loader_pulls_actual_sop_baseline_from_workspace() -> None:
    """AC: SOP threshold values pulled from
    data/seed/reference/sop-baseline.json."""
    here = Path(__file__).resolve().parent.parent.parent
    sop_path = here / "data" / "seed" / "reference" / "sop-baseline.json"
    assert sop_path.is_file()
    thr = load_snowbank_thresholds(sop_path)
    raw = json.loads(sop_path.read_text(encoding="utf-8"))
    assert thr["max_height_cm"] == raw["snowbank"]["max_height_cm"]
    assert thr["runway_setback_min_m"] == raw["snowbank"]["runway_setback_min_m"]
    assert thr["taxiway_setback_min_m"] == raw["snowbank"]["taxiway_setback_min_m"]


def test_loader_falls_back_to_defaults_for_missing_file(tmp_path: Path) -> None:
    thr = load_snowbank_thresholds(tmp_path / "does-not-exist.json")
    assert thr == DEFAULT_SOP_THRESHOLDS


def test_loader_falls_back_to_defaults_for_missing_block(tmp_path: Path) -> None:
    p = tmp_path / "sop.json"
    p.write_text(json.dumps({"version": "v1"}))
    assert load_snowbank_thresholds(p) == DEFAULT_SOP_THRESHOLDS


def test_loader_rejects_zero_or_negative_thresholds(tmp_path: Path) -> None:
    p = tmp_path / "sop.json"
    p.write_text(json.dumps({"snowbank": {"max_height_cm": -5, "runway_setback_min_m": 0}}))
    thr = load_snowbank_thresholds(p)
    # Both nonsense values ignored; defaults remain.
    assert thr["max_height_cm"] == DEFAULT_SOP_THRESHOLDS["max_height_cm"]
    assert thr["runway_setback_min_m"] == DEFAULT_SOP_THRESHOLDS["runway_setback_min_m"]


# ── Custom thresholds + override paths ───────────────────────────────


@pytest.mark.asyncio
async def test_custom_thresholds_change_violation_outcome() -> None:
    """Same snowbank, different SOP → different compliance verdict."""
    permissive = SnowbankDetector(
        seed=0,
        thresholds={
            "max_height_cm": 500.0,
            "runway_setback_min_m": 1.0,
            "taxiway_setback_min_m": 1.0,
        },
    )
    strict = SnowbankDetector(
        seed=0,
        thresholds={
            "max_height_cm": 50.0,
            "runway_setback_min_m": 20.0,
            "taxiway_setback_min_m": 20.0,
        },
    )
    frame = _frame(metadata=_truth(location_class="runway", height_cm=100, setback_m=8))
    assert await permissive.detect(frame) == []
    out = await strict.detect(frame)
    assert set(out[0].metadata["violations"]) == {"height_exceeded", "setback_runway"}


# ── Resilience + identity ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_truth_emits_no_detection() -> None:
    det = SnowbankDetector(seed=0, noise_rate=0.0)
    assert await det.detect(_frame(metadata={})) == []


@pytest.mark.asyncio
async def test_present_false_treated_as_no_truth() -> None:
    det = SnowbankDetector(seed=0, noise_rate=0.0)
    out = await det.detect(_frame(metadata={"fixture_truth": {"snowbank": {"present": False}}}))
    assert out == []


@pytest.mark.asyncio
async def test_noise_emits_low_confidence_when_enabled() -> None:
    det = SnowbankDetector(seed=1, noise_rate=1.0, noise_confidence_max=0.4)
    out = await det.detect(_frame(metadata={}))
    assert len(out) == 1
    assert out[0].confidence < 0.5
    assert out[0].metadata.get("noise") is True


@pytest.mark.asyncio
async def test_seeded_output_is_deterministic() -> None:
    a = SnowbankDetector(seed=7)
    b = SnowbankDetector(seed=7)
    frame = _frame(metadata=_truth(location_class="runway", height_cm=300))
    out_a = (await a.detect(frame))[0]
    out_b = (await b.detect(frame))[0]
    assert out_a.confidence == out_b.confidence
    assert out_a.detection_id == out_b.detection_id


@pytest.mark.asyncio
async def test_negative_measurements_treated_as_absent() -> None:
    """A negative height/setback in the truth shouldn't quietly bypass
    the threshold check — both treated as absent."""
    det = SnowbankDetector(seed=0)
    out = await det.detect(
        _frame(metadata=_truth(location_class="runway", height_cm=-1, setback_m=-5))
    )
    # No height + no setback → no comparable measurements → compliant.
    assert out == []


@pytest.mark.asyncio
async def test_invalid_bbox_is_silently_dropped() -> None:
    det = SnowbankDetector(seed=0)
    bad = _truth(
        location_class="runway",
        height_cm=300,
        bbox={"x": 0.5, "y": 0.5, "w": -0.1, "h": 0.2},
    )
    out = await det.detect(_frame(metadata=bad))
    assert out[0].bbox is None


@pytest.mark.asyncio
async def test_detector_is_registered_for_camera_only() -> None:
    det = SnowbankDetector(seed=0)
    assert det.applicable_sensor_types == ("camera",)
    assert det.name == "snowbank"


def test_zero_threshold_raises() -> None:
    with pytest.raises(ValueError, match="max_height_cm"):
        SnowbankDetector(seed=0, thresholds={"max_height_cm": 0})
