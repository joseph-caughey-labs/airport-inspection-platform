"""Temporal smoothing — single-frame suppression + sustained-fire emit."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from _fakes import FakeBroker, FakeRedis

from src.confidence import (
    DEFAULT_SMOOTHED_CLASSES,
    DEFAULT_THRESHOLD,
    DEFAULT_WINDOW_SIZE,
    Calibrator,
    TemporalSmoother,
)
from src.detectors import DetectorRegistry
from src.models import (
    DetectionPayload,
    EventSource,
    GeoPoint,
    SensorFrameEvent,
    SensorFramePayload,
)
from src.pipeline import AiRuntime, RuntimeConfig


def _det(
    detection_class: str = "fod",
    confidence: float = 0.85,
    sensor_id: str = "CAM-1",
    frame_id: str = "F-1",
) -> DetectionPayload:
    return DetectionPayload(
        detection_id=f"d-{detection_class}-{frame_id}",
        sensor_id=sensor_id,
        frame_id=frame_id,
        detection_class=detection_class,  # type: ignore[arg-type]
        confidence=confidence,
        severity_hint="critical",
        captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        geo=GeoPoint(lat=37.62, lng=-122.37),
    )


def _frame(frame_id: str = "F-1", sensor_id: str = "CAM-1") -> SensorFrameEvent:
    return SensorFrameEvent(
        event_id=f"e-{frame_id}",
        schema_version="v1",
        source=EventSource(service="sensor-gateway"),
        timestamp=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        correlation_id="corr-1",
        payload=SensorFramePayload(
            sensor_id=sensor_id,
            sensor_type="camera",
            frame_id=frame_id,
            captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
            geo=GeoPoint(lat=37.62, lng=-122.37),
        ),
    )


# ─── Smoother defaults ───────────────────────────────────────────────


def test_defaults_match_t309_ac() -> None:
    """AC default config: single-frame anomalies suppressed,
    sustained 3+ frames emit. That implies window=5, threshold=3."""
    s = TemporalSmoother()
    assert s.window_size == DEFAULT_WINDOW_SIZE == 5
    assert s.threshold == DEFAULT_THRESHOLD == 3
    assert s.classes_to_smooth == DEFAULT_SMOOTHED_CLASSES == ("fod",)


def test_constructor_validates_window_and_threshold() -> None:
    with pytest.raises(ValueError, match="window_size"):
        TemporalSmoother(window_size=0)
    with pytest.raises(ValueError, match="threshold"):
        TemporalSmoother(threshold=0)
    with pytest.raises(ValueError, match="cannot exceed"):
        TemporalSmoother(window_size=3, threshold=5)


# ─── Single-frame suppression + sustained emit ───────────────────────


def test_single_frame_fod_is_suppressed_by_default() -> None:
    """AC: single-frame anomalies suppressed by default config."""
    s = TemporalSmoother()
    out = s.observe("CAM-1", [_det("fod")])
    assert out == []
    assert s.counters.detections_suppressed == 1
    assert s.counters.detections_emitted == 0


def test_sustained_three_frames_emits_with_smoothing_metadata() -> None:
    """AC: sustained anomalies (3+ frames) emit detection."""
    s = TemporalSmoother()
    out1 = s.observe("CAM-1", [_det("fod", frame_id="F1")])
    out2 = s.observe("CAM-1", [_det("fod", frame_id="F2")])
    out3 = s.observe("CAM-1", [_det("fod", frame_id="F3")])
    assert out1 == []
    assert out2 == []
    assert len(out3) == 1
    meta = out3[0].metadata["smoothing"]
    assert meta["window_count"] == 3
    assert meta["window_size"] == 5
    assert meta["threshold"] == 3
    assert s.counters.detections_emitted == 1
    assert s.counters.detections_suppressed == 2


def test_sustained_fire_emits_every_frame_once_threshold_met() -> None:
    s = TemporalSmoother(window_size=5, threshold=3)
    # Frames 1-3 (build up). Frames 4-6 should all emit.
    for i in range(1, 6 + 1):
        out = s.observe("CAM-1", [_det("fod", frame_id=f"F{i}")])
        if i <= 2:
            assert out == []
        else:
            assert len(out) == 1


def test_intermittent_fires_eventually_emit_after_threshold_in_window() -> None:
    """Three TRUE within the last 5 frames triggers emission, even
    with gaps between them."""
    s = TemporalSmoother(window_size=5, threshold=3)
    # Pattern: T F T F T → threshold met on the 5th frame
    outs: list[list[DetectionPayload]] = []
    for fid, fired in zip(
        ["F1", "F2", "F3", "F4", "F5"], [True, False, True, False, True], strict=True
    ):
        if fired:
            outs.append(s.observe("CAM-1", [_det("fod", frame_id=fid)]))
        else:
            outs.append(s.observe("CAM-1", []))
    assert outs[0] == []  # 1/5
    assert outs[2] == []  # 2/5
    assert len(outs[4]) == 1  # 3/5 — emit


def test_window_slides_and_old_fires_decay_out() -> None:
    """Three fires followed by a gap of `window_size` empty frames:
    the gap should push counts below threshold again."""
    s = TemporalSmoother(window_size=3, threshold=2)
    # Fire twice consecutively → second emits.
    assert s.observe("CAM-1", [_det("fod", frame_id="F1")]) == []
    out2 = s.observe("CAM-1", [_det("fod", frame_id="F2")])
    assert len(out2) == 1
    # Now three empty frames → window decays to all False.
    for _ in range(3):
        assert s.observe("CAM-1", []) == []
    # A single new fire shouldn't emit (window: F F T → count 1 < 2).
    out_after = s.observe("CAM-1", [_det("fod", frame_id="F6")])
    assert out_after == []


# ─── Cross-class + cross-sensor isolation ────────────────────────────


def test_sensors_isolated() -> None:
    """Two sensors' windows don't cross-contaminate."""
    s = TemporalSmoother()
    s.observe("CAM-A", [_det("fod", frame_id="A1")])
    s.observe("CAM-A", [_det("fod", frame_id="A2")])
    # Three CAM-B fires must reach threshold independently.
    s.observe("CAM-B", [_det("fod", frame_id="B1")])
    s.observe("CAM-B", [_det("fod", frame_id="B2")])
    out_b = s.observe("CAM-B", [_det("fod", frame_id="B3")])
    assert len(out_b) == 1
    # CAM-A still only has 2 in its window; another A fire emits.
    out_a = s.observe("CAM-A", [_det("fod", frame_id="A3")])
    assert len(out_a) == 1


def test_classes_isolated() -> None:
    """Different smoothed classes have independent windows."""
    s = TemporalSmoother(classes_to_smooth=("fod", "wildlife"))
    # 2 FOD fires don't help a single wildlife fire.
    s.observe("CAM-1", [_det("fod", frame_id="F1")])
    s.observe("CAM-1", [_det("fod", frame_id="F2")])
    out = s.observe("CAM-1", [_det("wildlife", frame_id="F3")])
    assert out == []  # wildlife window has only 1 fire


def test_unsmoothed_classes_pass_through_unchanged() -> None:
    """Anything not in classes_to_smooth bypasses smoothing entirely."""
    s = TemporalSmoother()  # default ("fod",)
    out = s.observe(
        "CAM-1",
        [_det("crack", frame_id="F1"), _det("anomaly", frame_id="F1")],
    )
    assert {d.detection_class for d in out} == {"crack", "anomaly"}
    # And no smoothing metadata was added.
    assert all("smoothing" not in d.metadata for d in out)


def test_mixed_frame_passes_unsmoothed_and_evaluates_smoothed() -> None:
    """Single-frame: crack passes through, fod is suppressed."""
    s = TemporalSmoother()
    out = s.observe(
        "CAM-1",
        [_det("crack", frame_id="F1"), _det("fod", frame_id="F1")],
    )
    classes = [d.detection_class for d in out]
    assert classes == ["crack"]


# ─── Configurability ─────────────────────────────────────────────────


def test_configurable_window_and_threshold() -> None:
    """AC: configurable window + threshold."""
    s = TemporalSmoother(window_size=3, threshold=2)
    s.observe("CAM-1", [_det("fod", frame_id="F1")])
    out = s.observe("CAM-1", [_det("fod", frame_id="F2")])
    assert len(out) == 1


def test_threshold_equal_to_window_requires_full_consensus() -> None:
    s = TemporalSmoother(window_size=4, threshold=4)
    for fid in ("F1", "F2", "F3"):
        assert s.observe("CAM-1", [_det("fod", frame_id=fid)]) == []
    out = s.observe("CAM-1", [_det("fod", frame_id="F4")])
    assert len(out) == 1


def test_reset_clears_state() -> None:
    s = TemporalSmoother()
    for fid in ("F1", "F2"):
        s.observe("CAM-1", [_det("fod", frame_id=fid)])
    s.reset("CAM-1")
    # After reset, single new fire suppressed again.
    out = s.observe("CAM-1", [_det("fod", frame_id="F3")])
    assert out == []


def test_reset_all_clears_everything() -> None:
    s = TemporalSmoother()
    s.observe("CAM-1", [_det("fod", frame_id="F1")])
    s.observe("CAM-2", [_det("fod", frame_id="F1")])
    s.reset()
    # Both sensors fresh.
    assert s.observe("CAM-1", [_det("fod", frame_id="F2")]) == []
    assert s.observe("CAM-2", [_det("fod", frame_id="F2")]) == []


# ─── Runtime integration ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_runtime_suppresses_single_frame_fod_by_default(
    fake_redis: FakeRedis, fake_broker: FakeBroker
) -> None:
    """End-to-end through AiRuntime: one frame with FOD detection
    should be suppressed by the default smoother."""

    class _StubFod:
        name = "stub"
        applicable_sensor_types = ("camera",)

        async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
            return [_det("fod", frame_id=frame.payload.frame_id)]

    registry = DetectorRegistry()
    registry.register(_StubFod())
    runtime = AiRuntime(
        redis=fake_redis,
        registry=registry,
        config=RuntimeConfig(),
        calibrator=Calibrator(),
    )
    await runtime.handle_frame(_frame("F1"))
    detections_published = [ch for ch, _ in fake_broker.published if ch.startswith("ai.detection.")]
    assert detections_published == []
    assert runtime.counters.detections_published == 0
    assert runtime.counters.detections_suppressed_by_smoothing == 1


@pytest.mark.asyncio
async def test_runtime_emits_after_three_sustained_frames(
    fake_redis: FakeRedis, fake_broker: FakeBroker
) -> None:
    class _StubFod:
        name = "stub"
        applicable_sensor_types = ("camera",)

        async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
            return [_det("fod", frame_id=frame.payload.frame_id)]

    registry = DetectorRegistry()
    registry.register(_StubFod())
    runtime = AiRuntime(
        redis=fake_redis,
        registry=registry,
        config=RuntimeConfig(),
        calibrator=Calibrator(),
    )
    for fid in ("F1", "F2", "F3"):
        await runtime.handle_frame(_frame(fid))
    detection_envelopes = [
        json.loads(payload)
        for ch, payload in fake_broker.published
        if ch.startswith("ai.detection.")
    ]
    assert len(detection_envelopes) == 1
    assert detection_envelopes[0]["payload"]["frame_id"] == "F3"
    # Smoothing metadata is carried through.
    meta = detection_envelopes[0]["payload"]["metadata"]
    assert meta["smoothing"]["window_count"] == 3


@pytest.mark.asyncio
async def test_runtime_with_no_smoothed_classes_passes_through(
    fake_redis: FakeRedis, fake_broker: FakeBroker
) -> None:
    """A test-only smoother with empty classes_to_smooth bypasses
    suppression entirely."""

    class _StubFod:
        name = "stub"
        applicable_sensor_types = ("camera",)

        async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
            return [_det("fod", frame_id=frame.payload.frame_id)]

    registry = DetectorRegistry()
    registry.register(_StubFod())
    runtime = AiRuntime(
        redis=fake_redis,
        registry=registry,
        config=RuntimeConfig(),
        calibrator=Calibrator(),
        smoother=TemporalSmoother(classes_to_smooth=()),
    )
    await runtime.handle_frame(_frame("F1"))
    detections_published = [ch for ch, _ in fake_broker.published if ch.startswith("ai.detection.")]
    assert len(detections_published) == 1
    assert runtime.counters.detections_suppressed_by_smoothing == 0
