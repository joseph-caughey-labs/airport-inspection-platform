"""End-to-end runtime: published frames flow to detectors and the
publisher emits detection envelopes on the right channels.

The test drives the FakeBroker (in conftest) so we exercise the full
consumer → orchestrator → publisher path without any docker.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import pytest
from _fakes import FakeBroker, FakeRedis

from src.detectors import DetectorRegistry
from src.models import (
    DetectionPayload,
    EventSource,
    GeoPoint,
    SensorFrameEvent,
    SensorFramePayload,
)
from src.pipeline import AiRuntime, RuntimeConfig


def _frame_json(frame_id: str = "F-1") -> str:
    event = SensorFrameEvent(
        event_id=f"e-{frame_id}",
        schema_version="v1",
        source=EventSource(service="sensor-gateway"),
        timestamp=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        correlation_id="corr-1",
        payload=SensorFramePayload(
            sensor_id="CAM-1",
            sensor_type="camera",
            frame_id=frame_id,
            captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
            geo=GeoPoint(lat=37.62, lng=-122.37),
        ),
    )
    return event.model_dump_json()


class _StubDetector:
    name = "stub"
    applicable_sensor_types = ("camera",)

    async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        return [
            DetectionPayload(
                detection_id=f"det-{frame.payload.frame_id}",
                sensor_id=frame.payload.sensor_id,
                frame_id=frame.payload.frame_id,
                detection_class="fod",
                confidence=0.91,
                severity_hint="critical",
                captured_at=frame.payload.captured_at,
                geo=frame.payload.geo,
            )
        ]


async def _wait_for_published_count(broker: FakeBroker, target: int, timeout: float = 2.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if len(broker.published) >= target:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(
        f"timed out waiting for {target} published frames; got {len(broker.published)}"
    )


@pytest.mark.asyncio
async def test_runtime_dispatches_frame_and_publishes_detection(
    fake_redis: FakeRedis,
    fake_broker: FakeBroker,
) -> None:
    registry = DetectorRegistry()
    registry.register(_StubDetector())

    runtime = AiRuntime(redis=fake_redis, registry=registry, config=RuntimeConfig(seed=42))
    await runtime.start()
    try:
        await fake_broker.publish("sensor.frame.captured", _frame_json("F-1"))
        # The detection should land on ai.detection.fod.emitted.
        await _wait_for_published_count(fake_broker, target=2)
        # First publish was the frame we injected; second is the detection.
        det_channel, det_raw = fake_broker.published[1]
        assert det_channel == "ai.detection.fod.emitted"
        envelope = json.loads(det_raw)
        assert envelope["payload"]["detection_id"] == "det-F-1"
        assert envelope["correlation_id"] == "corr-1"
        assert envelope["idempotency_key"] == "detection:CAM-1:F-1:fod"
    finally:
        await runtime.stop()


@pytest.mark.asyncio
async def test_runtime_with_empty_registry_drops_frame_silently(
    fake_redis: FakeRedis,
    fake_broker: FakeBroker,
) -> None:
    runtime = AiRuntime(redis=fake_redis, registry=DetectorRegistry(), config=RuntimeConfig())
    await runtime.start()
    try:
        await fake_broker.publish("sensor.frame.captured", _frame_json())
        await asyncio.sleep(0.05)
        # Only the frame we injected; no detection was emitted.
        assert all(ch == "sensor.frame.captured" for ch, _ in fake_broker.published)
        assert runtime.orchestrator.counters.skipped_no_detectors == 1
    finally:
        await runtime.stop()


@pytest.mark.asyncio
async def test_runtime_decode_error_does_not_break_pipeline(
    fake_redis: FakeRedis,
    fake_broker: FakeBroker,
) -> None:
    registry = DetectorRegistry()
    registry.register(_StubDetector())
    runtime = AiRuntime(redis=fake_redis, registry=registry, config=RuntimeConfig())
    await runtime.start()
    try:
        # Garbage frame — should bump decode_errors and not crash.
        await fake_broker.publish("sensor.frame.captured", "{not json")
        # Real frame after — should still be processed.
        await fake_broker.publish("sensor.frame.captured", _frame_json("F-2"))
        await _wait_for_published_count(fake_broker, target=3)
        assert runtime.consumer.counters.decode_errors == 1
        # The detection channel must show up among the published list.
        detection_channels = [
            ch for ch, _ in fake_broker.published if ch.startswith("ai.detection.")
        ]
        assert "ai.detection.fod.emitted" in detection_channels
    finally:
        await runtime.stop()
