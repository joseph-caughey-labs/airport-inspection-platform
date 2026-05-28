"""Detector registry + orchestrator dispatch behavior."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from src.detectors import DetectorRegistry
from src.models import (
    DetectionPayload,
    EventSource,
    GeoPoint,
    SensorFrameEvent,
    SensorFramePayload,
)
from src.pipeline.orchestrator import DetectorOrchestrator


def _frame(sensor_type: str = "camera") -> SensorFrameEvent:
    return SensorFrameEvent(
        event_id="e-1",
        schema_version="v1",
        source=EventSource(service="sensor-gateway"),
        timestamp=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        payload=SensorFramePayload(
            sensor_id="CAM-1",
            sensor_type=sensor_type,  # type: ignore[arg-type]
            frame_id="F-1",
            captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
            geo=GeoPoint(lat=37.62, lng=-122.37),
        ),
    )


class _Detector:
    def __init__(
        self,
        name: str,
        sensor_types: tuple[str, ...] = ("camera",),
        produces: list[DetectionPayload] | None = None,
        raises: BaseException | None = None,
    ) -> None:
        self._name = name
        self._sensor_types = sensor_types
        self._produces = produces or []
        self._raises = raises
        self.calls: list[SensorFrameEvent] = []

    @property
    def name(self) -> str:
        return self._name

    @property
    def applicable_sensor_types(self) -> tuple[str, ...]:
        return self._sensor_types

    async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        self.calls.append(frame)
        if self._raises is not None:
            raise self._raises
        return list(self._produces)


def _det(name: str = "d-1") -> DetectionPayload:
    return DetectionPayload(
        detection_id=name,
        sensor_id="CAM-1",
        frame_id="F-1",
        detection_class="fod",
        confidence=0.5,
        severity_hint="info",
        captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_registry_rejects_duplicate_names() -> None:
    registry = DetectorRegistry()
    registry.register(_Detector("a"))
    with pytest.raises(ValueError, match="already registered"):
        registry.register(_Detector("a"))


@pytest.mark.asyncio
async def test_orchestrator_skips_when_no_detectors_apply() -> None:
    registry = DetectorRegistry()
    registry.register(_Detector("camera-only"))
    orch = DetectorOrchestrator(registry)
    detections = await orch.dispatch(_frame(sensor_type="weather"))
    assert detections == []
    assert orch.counters.skipped_no_detectors == 1
    assert orch.counters.detections_emitted == 0


@pytest.mark.asyncio
async def test_orchestrator_flattens_detections_from_multiple_detectors() -> None:
    registry = DetectorRegistry()
    registry.register(_Detector("a", produces=[_det("a-1")]))
    registry.register(_Detector("b", produces=[_det("b-1"), _det("b-2")]))
    orch = DetectorOrchestrator(registry)
    detections = await orch.dispatch(_frame())
    ids = {d.detection_id for d in detections}
    assert ids == {"a-1", "b-1", "b-2"}
    assert orch.counters.detections_emitted == 3


@pytest.mark.asyncio
async def test_orchestrator_isolates_a_failing_detector() -> None:
    registry = DetectorRegistry()
    registry.register(_Detector("bad", raises=RuntimeError("boom")))
    registry.register(_Detector("good", produces=[_det("ok")]))
    orch = DetectorOrchestrator(registry)
    detections = await orch.dispatch(_frame())
    assert [d.detection_id for d in detections] == ["ok"]
    assert orch.counters.detector_errors == 1


@pytest.mark.asyncio
async def test_orchestrator_filters_by_applicable_sensor_type() -> None:
    registry = DetectorRegistry()
    camera = _Detector("cam-only", sensor_types=("camera",), produces=[_det("c")])
    lidar = _Detector("lidar-only", sensor_types=("lidar",), produces=[_det("l")])
    registry.register(camera)
    registry.register(lidar)
    orch = DetectorOrchestrator(registry)

    detections = await orch.dispatch(_frame(sensor_type="camera"))
    assert [d.detection_id for d in detections] == ["c"]
    assert camera.calls and not lidar.calls


@pytest.mark.asyncio
async def test_orchestrator_parallel_mode_runs_all_detectors() -> None:
    registry = DetectorRegistry()
    a = _Detector("a", produces=[_det("a")])
    b = _Detector("b", produces=[_det("b")])
    registry.register(a)
    registry.register(b)
    orch = DetectorOrchestrator(registry, parallel=True)
    detections = await orch.dispatch(_frame())
    assert {d.detection_id for d in detections} == {"a", "b"}
