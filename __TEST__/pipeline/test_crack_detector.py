"""Crack detector — three subtypes + severity band classification."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from src.detectors import CrackDetector
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
    crack_type: str = "longitudinal",
    width_mm: float | None = None,
    bbox: dict[str, float] | None = None,
    base_confidence: float | None = None,
) -> dict[str, Any]:
    crack: dict[str, Any] = {"present": True, "crack_type": crack_type}
    if width_mm is not None:
        crack["width_mm"] = width_mm
    if bbox is not None:
        crack["bbox"] = bbox
    if base_confidence is not None:
        crack["base_confidence"] = base_confidence
    return {"fixture_truth": {"crack": crack}}


@pytest.mark.asyncio
async def test_all_three_crack_classes_emit_a_detection() -> None:
    """AC: all 3 crack classes detectable on fixture frames."""
    det = CrackDetector(seed=0)
    for ct in ("longitudinal", "transverse", "alligator"):
        out = await det.detect(_frame(metadata=_truth(crack_type=ct)))
        assert len(out) == 1, f"no detection for crack_type={ct}"
        assert out[0].detection_class == "crack"
        assert out[0].metadata["crack_type"] == ct


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("crack_type", "width_mm", "expected"),
    [
        # Linear: < 6mm → low, 6–19mm → medium, ≥ 19mm → high.
        ("longitudinal", None, "low"),
        ("longitudinal", 0, "low"),
        ("longitudinal", 5.9, "low"),
        ("longitudinal", 6.0, "medium"),
        ("longitudinal", 18.99, "medium"),
        ("longitudinal", 19.0, "high"),
        ("longitudinal", 30, "high"),
        ("transverse", 4.0, "low"),
        ("transverse", 12.0, "medium"),
        ("transverse", 22.0, "high"),
        # Alligator: high baseline, critical at ≥ 19mm.
        ("alligator", None, "high"),
        ("alligator", 5.0, "high"),
        ("alligator", 18.99, "high"),
        ("alligator", 19.0, "critical"),
        ("alligator", 25.0, "critical"),
    ],
)
async def test_severity_band_matches_domain_expert_rules(
    crack_type: str, width_mm: float | None, expected: str
) -> None:
    """AC: severity band classification matches Domain Expert rules."""
    det = CrackDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(crack_type=crack_type, width_mm=width_mm)))
    assert out[0].severity_hint == expected


@pytest.mark.asyncio
async def test_unknown_subtype_drops_truth_silently() -> None:
    """Unknown subtypes never accidentally inflate severity."""
    det = CrackDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(crack_type="diagonal")))  # type: ignore[arg-type]
    assert out == []


@pytest.mark.asyncio
async def test_width_recorded_in_metadata_when_present() -> None:
    det = CrackDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(crack_type="longitudinal", width_mm=12.5)))
    assert out[0].metadata["width_mm"] == 12.5


@pytest.mark.asyncio
async def test_negative_width_is_treated_as_absent() -> None:
    det = CrackDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(crack_type="longitudinal", width_mm=-1.0)))
    assert "width_mm" not in out[0].metadata
    assert out[0].severity_hint == "low"


@pytest.mark.asyncio
async def test_no_truth_emits_no_detection() -> None:
    """Non-crack frames produce no detection in deterministic mode."""
    det = CrackDetector(seed=42, noise_rate=0.0)
    out = await det.detect(_frame(metadata={}))
    assert out == []


@pytest.mark.asyncio
async def test_noise_emits_low_confidence_when_enabled() -> None:
    det = CrackDetector(seed=1, noise_rate=1.0, noise_confidence_max=0.4)
    out = await det.detect(_frame(metadata={}))
    assert len(out) == 1
    assert out[0].confidence < 0.5
    assert out[0].metadata.get("noise") is True


@pytest.mark.asyncio
async def test_seeded_output_is_deterministic() -> None:
    a = CrackDetector(seed=7)
    b = CrackDetector(seed=7)
    frame = _frame(metadata=_truth(crack_type="alligator", width_mm=10.0))
    out_a = (await a.detect(frame))[0]
    out_b = (await b.detect(frame))[0]
    assert out_a.confidence == out_b.confidence
    assert out_a.detection_id == out_b.detection_id


@pytest.mark.asyncio
async def test_invalid_bbox_is_silently_dropped() -> None:
    det = CrackDetector(seed=0)
    bad = _truth(crack_type="transverse", bbox={"x": 0.5, "y": 0.5, "w": -0.1, "h": 0.2})
    out = await det.detect(_frame(metadata=bad))
    assert out[0].bbox is None


@pytest.mark.asyncio
async def test_detector_is_registered_for_camera_only() -> None:
    det = CrackDetector(seed=0)
    assert det.applicable_sensor_types == ("camera",)
    assert det.name == "crack"


@pytest.mark.asyncio
async def test_invalid_noise_rate_raises() -> None:
    with pytest.raises(ValueError, match="noise_rate"):
        CrackDetector(seed=0, noise_rate=-0.01)
    with pytest.raises(ValueError, match="noise_rate"):
        CrackDetector(seed=0, noise_rate=1.5)


@pytest.mark.asyncio
async def test_present_false_treated_as_no_truth() -> None:
    det = CrackDetector(seed=0, noise_rate=0.0)
    out = await det.detect(_frame(metadata={"fixture_truth": {"crack": {"present": False}}}))
    assert out == []
