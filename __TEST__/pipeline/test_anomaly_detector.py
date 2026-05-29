"""Anomaly detector — low-confidence HITL routing flag."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from src.detectors import AnomalyDetector
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
    foreground_score: float | None = 0.6,
    bbox: dict[str, float] | None = None,
) -> dict[str, Any]:
    block: dict[str, Any] = {"present": True}
    if foreground_score is not None:
        block["foreground_score"] = foreground_score
    if bbox is not None:
        block["bbox"] = bbox
    return {"fixture_truth": {"anomaly": block}}


@pytest.mark.asyncio
async def test_emits_at_low_confidence_for_hitl_routing() -> None:
    """AC: emits low-confidence detections that flag HITL routing in
    Phase 4. The detector guarantees confidence stays under
    confidence_max (default 0.6) so the queue threshold can be set
    without coordinating with this module."""
    det = AnomalyDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(foreground_score=1.0)))
    assert len(out) == 1
    assert out[0].confidence <= det.confidence_max
    assert out[0].metadata["hitl_routing"] is True


@pytest.mark.asyncio
async def test_severity_is_always_info() -> None:
    """Anomalies aren't alarms — they're 'please look at this' markers."""
    det = AnomalyDetector(seed=0)
    for score in (0.1, 0.5, 0.9):
        out = await det.detect(_frame(metadata=_truth(foreground_score=score)))
        assert out[0].severity_hint == "info"


@pytest.mark.asyncio
async def test_foreground_score_scales_into_band() -> None:
    det = AnomalyDetector(seed=0, confidence_min=0.2, confidence_max=0.6)
    low = (await det.detect(_frame(metadata=_truth(foreground_score=0.0))))[0]
    mid = (await det.detect(_frame(metadata=_truth(foreground_score=0.5))))[0]
    high = (await det.detect(_frame(metadata=_truth(foreground_score=1.0))))[0]
    assert low.confidence == pytest.approx(0.2)
    assert mid.confidence == pytest.approx(0.4)
    assert high.confidence == pytest.approx(0.6)


@pytest.mark.asyncio
async def test_confidence_min_floor_enforced() -> None:
    det = AnomalyDetector(seed=0, confidence_min=0.25, confidence_max=0.6)
    out = await det.detect(_frame(metadata=_truth(foreground_score=None)))
    assert out[0].confidence >= 0.25


@pytest.mark.asyncio
async def test_confidence_max_ceiling_enforced() -> None:
    det = AnomalyDetector(seed=0, confidence_min=0.2, confidence_max=0.5)
    # Even with a foreground_score = 1, the cap is hard.
    out = await det.detect(_frame(metadata=_truth(foreground_score=1.0)))
    assert out[0].confidence <= 0.5


@pytest.mark.asyncio
async def test_no_truth_emits_no_detection() -> None:
    det = AnomalyDetector(seed=0)
    assert await det.detect(_frame(metadata={})) == []


@pytest.mark.asyncio
async def test_present_false_treated_as_no_truth() -> None:
    det = AnomalyDetector(seed=0)
    out = await det.detect(_frame(metadata={"fixture_truth": {"anomaly": {"present": False}}}))
    assert out == []


@pytest.mark.asyncio
async def test_seeded_output_is_deterministic_without_foreground_score() -> None:
    a = AnomalyDetector(seed=11)
    b = AnomalyDetector(seed=11)
    frame = _frame(metadata=_truth(foreground_score=None))
    out_a = (await a.detect(frame))[0]
    out_b = (await b.detect(frame))[0]
    assert out_a.confidence == out_b.confidence
    assert out_a.detection_id == out_b.detection_id


@pytest.mark.asyncio
async def test_metadata_carries_confidence_band_for_downstream() -> None:
    det = AnomalyDetector(seed=0, confidence_min=0.15, confidence_max=0.55)
    out = await det.detect(_frame(metadata=_truth(foreground_score=0.5)))
    assert out[0].metadata["confidence_band"] == [0.15, 0.55]


@pytest.mark.asyncio
async def test_invalid_bbox_is_silently_dropped() -> None:
    det = AnomalyDetector(seed=0)
    bad = _truth(bbox={"x": 0.5, "y": 0.5, "w": -0.1, "h": 0.2})
    out = await det.detect(_frame(metadata=bad))
    assert out[0].bbox is None


@pytest.mark.asyncio
async def test_out_of_range_foreground_score_treated_as_absent() -> None:
    det = AnomalyDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(foreground_score=1.5)))
    # 1.5 is invalid — falls back to the RNG path, but still within band.
    assert det.confidence_max >= out[0].confidence >= 0.2


@pytest.mark.asyncio
async def test_detector_is_registered_for_camera_only() -> None:
    det = AnomalyDetector(seed=0)
    assert det.applicable_sensor_types == ("camera",)
    assert det.name == "anomaly"


def test_invalid_band_raises() -> None:
    with pytest.raises(ValueError, match="confidence_max"):
        AnomalyDetector(seed=0, confidence_max=0)
    with pytest.raises(ValueError, match="confidence_min"):
        AnomalyDetector(seed=0, confidence_min=0.7, confidence_max=0.6)
