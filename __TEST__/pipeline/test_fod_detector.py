"""FOD detector — truth + noise + severity matrix."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from src.detectors import FodDetector
from src.models import (
    EventSource,
    GeoPoint,
    SensorFrameEvent,
    SensorFramePayload,
)


def _frame(
    metadata: dict[str, Any] | None = None,
    sensor_type: str = "camera",
    frame_id: str = "F-1",
) -> SensorFrameEvent:
    return SensorFrameEvent(
        event_id=f"e-{frame_id}",
        schema_version="v1",
        source=EventSource(service="sensor-gateway"),
        timestamp=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        payload=SensorFramePayload(
            sensor_id="CAM-RWY10L-01",
            sensor_type=sensor_type,  # type: ignore[arg-type]
            frame_id=frame_id,
            captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
            geo=GeoPoint(lat=37.62, lng=-122.37),
            metadata=metadata or {},
        ),
    )


def _truth(
    location: str = "runway",
    bbox: dict[str, float] | None = None,
    base_confidence: float | None = None,
) -> dict[str, Any]:
    fod: dict[str, Any] = {"present": True, "location": location}
    if bbox is not None:
        fod["bbox"] = bbox
    if base_confidence is not None:
        fod["base_confidence"] = base_confidence
    return {"fixture_truth": {"fod": fod}}


@pytest.mark.asyncio
async def test_fod_truth_emits_detection_above_acceptance_confidence() -> None:
    """AC: at least 3 fixture frames detected at > 0.8 confidence."""
    det = FodDetector(seed=42)
    for i in range(3):
        meta = _truth(location="runway", bbox={"x": 0.4, "y": 0.5, "w": 0.05, "h": 0.05})
        out = await det.detect(_frame(metadata=meta, frame_id=f"F-{i}"))
        assert len(out) == 1
        assert out[0].confidence > 0.8, f"frame {i} below the AC threshold"


@pytest.mark.asyncio
async def test_severity_matrix_matches_location() -> None:
    """AC: severity hint matches the Domain Expert's location matrix."""
    det = FodDetector(seed=0)

    rwy = (await det.detect(_frame(metadata=_truth(location="runway"))))[0]
    assert rwy.severity_hint == "critical"

    twy = (await det.detect(_frame(metadata=_truth(location="taxiway"))))[0]
    assert twy.severity_hint == "high"

    apn = (await det.detect(_frame(metadata=_truth(location="apron"))))[0]
    assert apn.severity_hint == "medium"


@pytest.mark.asyncio
async def test_unknown_location_falls_back_to_medium() -> None:
    det = FodDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(location="hangar")))
    assert out[0].severity_hint == "medium"


@pytest.mark.asyncio
async def test_no_truth_emits_no_detection_in_deterministic_mode() -> None:
    """AC: non-FOD frames produce no detection (noise_rate=0 default)."""
    det = FodDetector(seed=42, noise_rate=0.0)
    out = await det.detect(_frame(metadata={}))
    assert out == []


@pytest.mark.asyncio
async def test_noise_emits_low_confidence_when_enabled() -> None:
    """When noise_rate > 0, occasional decoys appear under the AC threshold."""
    det = FodDetector(seed=1, noise_rate=1.0, noise_confidence_max=0.4)
    out = await det.detect(_frame(metadata={}))
    assert len(out) == 1
    assert out[0].confidence < 0.5
    assert out[0].metadata.get("noise") is True


@pytest.mark.asyncio
async def test_seeded_output_is_deterministic() -> None:
    """Same seed → same confidence + same detection_id on the same frame."""
    a = FodDetector(seed=7)
    b = FodDetector(seed=7)
    frame = _frame(metadata=_truth(base_confidence=0.9))
    out_a = (await a.detect(frame))[0]
    out_b = (await b.detect(frame))[0]
    assert out_a.confidence == out_b.confidence
    assert out_a.detection_id == out_b.detection_id


@pytest.mark.asyncio
async def test_different_seeds_produce_different_confidences() -> None:
    a = FodDetector(seed=1)
    b = FodDetector(seed=2)
    frame = _frame(metadata=_truth(base_confidence=0.9))
    ca = (await a.detect(frame))[0].confidence
    cb = (await b.detect(frame))[0].confidence
    assert ca != cb


@pytest.mark.asyncio
async def test_bbox_is_jittered_around_truth() -> None:
    det = FodDetector(seed=3, bbox_jitter=0.02)
    out = await det.detect(_frame(metadata=_truth(bbox={"x": 0.5, "y": 0.5, "w": 0.05, "h": 0.05})))
    bbox = out[0].bbox
    assert bbox is not None
    assert abs(bbox.x - 0.5) <= 0.02 + 1e-9
    assert abs(bbox.y - 0.5) <= 0.02 + 1e-9
    # Width / height preserved (we don't jitter dimensions — only position).
    assert bbox.w == pytest.approx(0.05)
    assert bbox.h == pytest.approx(0.05)


@pytest.mark.asyncio
async def test_missing_bbox_in_truth_yields_no_bbox_in_detection() -> None:
    det = FodDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth()))
    assert out[0].bbox is None


@pytest.mark.asyncio
async def test_invalid_bbox_in_truth_is_silently_dropped() -> None:
    det = FodDetector(seed=0)
    bad = _truth(bbox={"x": 0.5, "y": 0.5, "w": -0.1, "h": 0.1})
    out = await det.detect(_frame(metadata=bad))
    assert out[0].bbox is None


@pytest.mark.asyncio
async def test_metadata_records_location_and_truth_flag() -> None:
    det = FodDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(location="taxiway")))
    assert out[0].metadata["location"] == "taxiway"
    assert out[0].metadata["fixture_truth"] is True


@pytest.mark.asyncio
async def test_present_false_treated_as_no_truth() -> None:
    det = FodDetector(seed=0, noise_rate=0.0)
    out = await det.detect(_frame(metadata={"fixture_truth": {"fod": {"present": False}}}))
    assert out == []


@pytest.mark.asyncio
async def test_detector_is_registered_for_camera_only() -> None:
    det = FodDetector(seed=0)
    assert det.applicable_sensor_types == ("camera",)
    assert det.name == "fod"


@pytest.mark.asyncio
async def test_invalid_noise_rate_raises() -> None:
    with pytest.raises(ValueError, match="noise_rate"):
        FodDetector(seed=0, noise_rate=1.5)
    with pytest.raises(ValueError, match="noise_rate"):
        FodDetector(seed=0, noise_rate=-0.1)
