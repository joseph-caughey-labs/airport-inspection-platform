"""Wildlife detector — species classification + risk-buffer severity."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from src.detectors import WildlifeDetector, load_wildlife_thresholds
from src.detectors.wildlife import (
    DEFAULT_HIGH_RISK_CLASSES,
    DEFAULT_RUNWAY_BUFFER_M,
)
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
    species: str = "deer",
    distance_to_runway_m: float | None = 50.0,
    bbox: dict[str, float] | None = None,
    base_confidence: float | None = None,
) -> dict[str, Any]:
    w: dict[str, Any] = {"present": True, "species": species}
    if distance_to_runway_m is not None:
        w["distance_to_runway_m"] = distance_to_runway_m
    if bbox is not None:
        w["bbox"] = bbox
    if base_confidence is not None:
        w["base_confidence"] = base_confidence
    return {"fixture_truth": {"wildlife": w}}


# ── AC: species classification accuracy on fixtures ──────────────────


@pytest.mark.asyncio
async def test_classifies_each_fixture_species_correctly() -> None:
    """AC: classification accuracy on fixtures (each fixture species
    flows through unmodified into metadata.species)."""
    det = WildlifeDetector(seed=0)
    for species in ("deer", "coyote", "large_bird", "small_bird", "rabbit"):
        out = await det.detect(_frame(metadata=_truth(species=species)))
        assert len(out) == 1
        assert out[0].metadata["species"] == species


@pytest.mark.asyncio
async def test_high_risk_flag_matches_sop_set() -> None:
    det = WildlifeDetector(seed=0)
    deer = (await det.detect(_frame(metadata=_truth(species="deer"))))[0]
    bird = (await det.detect(_frame(metadata=_truth(species="small_bird"))))[0]
    assert deer.metadata["high_risk"] is True
    assert bird.metadata["high_risk"] is False


# ── Severity matrix ──────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("species", "distance_m", "expected"),
    [
        ("deer", 100, "critical"),
        ("coyote", 200, "critical"),
        ("large_bird", 50, "critical"),
        ("deer", 250, "high"),
        ("large_bird", 1000, "high"),
        ("small_bird", 100, "medium"),
        ("rabbit", 50, "medium"),
        ("small_bird", 500, "low"),
        ("rabbit", 1500, "low"),
    ],
)
async def test_severity_by_risk_and_buffer(species: str, distance_m: float, expected: str) -> None:
    det = WildlifeDetector(seed=0)
    out = await det.detect(
        _frame(metadata=_truth(species=species, distance_to_runway_m=distance_m))
    )
    assert out[0].severity_hint == expected


@pytest.mark.asyncio
async def test_buffer_boundary_exactly_at_threshold_is_inside() -> None:
    det = WildlifeDetector(seed=0, runway_buffer_m=200)
    out = await det.detect(_frame(metadata=_truth(species="deer", distance_to_runway_m=200)))
    assert out[0].metadata["within_runway_buffer"] is True
    assert out[0].severity_hint == "critical"


@pytest.mark.asyncio
async def test_unknown_distance_treated_as_outside_buffer() -> None:
    det = WildlifeDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(species="deer", distance_to_runway_m=None)))
    assert "within_runway_buffer" not in out[0].metadata
    assert out[0].severity_hint == "high"


# ── Loader ───────────────────────────────────────────────────────────


def test_loader_pulls_actual_sop_baseline_from_workspace() -> None:
    """AC: SOP threshold values pulled from sop-baseline.json."""
    here = Path(__file__).resolve().parent.parent.parent
    sop_path = here / "data" / "seed" / "reference" / "sop-baseline.json"
    species, buffer_m = load_wildlife_thresholds(sop_path)
    raw = json.loads(sop_path.read_text(encoding="utf-8"))
    assert list(species) == raw["wildlife"]["high_risk_classes"]
    assert buffer_m == raw["wildlife"]["alert_within_runway_buffer_m"]


def test_loader_falls_back_to_defaults_for_missing_file(tmp_path: Path) -> None:
    species, buffer_m = load_wildlife_thresholds(tmp_path / "missing.json")
    assert species == DEFAULT_HIGH_RISK_CLASSES
    assert buffer_m == DEFAULT_RUNWAY_BUFFER_M


def test_loader_falls_back_for_invalid_types(tmp_path: Path) -> None:
    p = tmp_path / "sop.json"
    p.write_text(
        json.dumps(
            {
                "wildlife": {
                    "high_risk_classes": [123, True],
                    "alert_within_runway_buffer_m": -50,
                }
            }
        )
    )
    species, buffer_m = load_wildlife_thresholds(p)
    assert species == DEFAULT_HIGH_RISK_CLASSES
    assert buffer_m == DEFAULT_RUNWAY_BUFFER_M


# ── Resilience + identity ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_truth_emits_no_detection() -> None:
    det = WildlifeDetector(seed=0, noise_rate=0.0)
    assert await det.detect(_frame(metadata={})) == []


@pytest.mark.asyncio
async def test_present_false_treated_as_no_truth() -> None:
    det = WildlifeDetector(seed=0, noise_rate=0.0)
    out = await det.detect(_frame(metadata={"fixture_truth": {"wildlife": {"present": False}}}))
    assert out == []


@pytest.mark.asyncio
async def test_missing_species_drops_truth() -> None:
    det = WildlifeDetector(seed=0, noise_rate=0.0)
    out = await det.detect(_frame(metadata={"fixture_truth": {"wildlife": {"present": True}}}))
    assert out == []


@pytest.mark.asyncio
async def test_seeded_output_is_deterministic() -> None:
    a = WildlifeDetector(seed=7)
    b = WildlifeDetector(seed=7)
    frame = _frame(metadata=_truth(species="coyote", distance_to_runway_m=80))
    out_a = (await a.detect(frame))[0]
    out_b = (await b.detect(frame))[0]
    assert out_a.confidence == out_b.confidence
    assert out_a.detection_id == out_b.detection_id


@pytest.mark.asyncio
async def test_detector_is_registered_for_camera_only() -> None:
    det = WildlifeDetector(seed=0)
    assert det.applicable_sensor_types == ("camera",)
    assert det.name == "wildlife"


@pytest.mark.asyncio
async def test_negative_distance_treated_as_absent() -> None:
    det = WildlifeDetector(seed=0)
    out = await det.detect(_frame(metadata=_truth(species="deer", distance_to_runway_m=-1)))
    assert "within_runway_buffer" not in out[0].metadata


def test_invalid_buffer_or_noise_rate_raises() -> None:
    with pytest.raises(ValueError, match="runway_buffer_m"):
        WildlifeDetector(seed=0, runway_buffer_m=0)
    with pytest.raises(ValueError, match="noise_rate"):
        WildlifeDetector(seed=0, noise_rate=-0.1)


@pytest.mark.asyncio
async def test_custom_high_risk_classes_override_default() -> None:
    det = WildlifeDetector(seed=0, high_risk_classes=("hawk",))
    deer = (await det.detect(_frame(metadata=_truth(species="deer"))))[0]
    hawk = (await det.detect(_frame(metadata=_truth(species="hawk"))))[0]
    assert deer.metadata["high_risk"] is False
    assert hawk.metadata["high_risk"] is True
