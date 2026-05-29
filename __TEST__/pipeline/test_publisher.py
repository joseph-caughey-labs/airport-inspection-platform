"""Publisher envelope shape + Redis channel routing."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from _fakes import FakeRedis

from src.models import DetectionPayload
from src.publishers import DetectionPublisher


def _det(detection_class: str = "fod") -> DetectionPayload:
    return DetectionPayload(
        detection_id="d-1",
        sensor_id="CAM-RWY10L-01",
        frame_id="F-1",
        detection_class=detection_class,  # type: ignore[arg-type]
        confidence=0.87,
        severity_hint="critical",
        captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_publish_routes_by_detection_class(fake_redis: FakeRedis) -> None:
    pub = DetectionPublisher(redis=fake_redis)
    channel = await pub.publish(_det("fod"))
    assert channel == "ai.detection.fod.emitted"
    assert pub.counters.published == 1
    assert fake_redis.broker.published[-1][0] == channel


@pytest.mark.asyncio
async def test_publish_envelope_has_canonical_fields(fake_redis: FakeRedis) -> None:
    pub = DetectionPublisher(
        redis=fake_redis,
        service_name="ai-inference",
        instance_id="ai-01",
        clock=lambda: datetime(2026, 5, 28, 10, 5, tzinfo=UTC),
        id_factory=lambda: "fixed-event-id",
    )
    await pub.publish(_det("crack"))
    raw = fake_redis.broker.published[-1][1]
    envelope = json.loads(raw)
    assert envelope["event_id"] == "fixed-event-id"
    assert envelope["event_type"] == "ai.detection.crack.emitted"
    assert envelope["schema_version"] == "v1"
    assert envelope["source"] == {"service": "ai-inference", "instance_id": "ai-01"}
    assert envelope["timestamp"].startswith("2026-05-28T10:05")
    assert envelope["idempotency_key"] == "detection:CAM-RWY10L-01:F-1:crack"
    assert envelope["payload"]["confidence"] == pytest.approx(0.87)


@pytest.mark.asyncio
async def test_publish_propagates_correlation_id(fake_redis: FakeRedis) -> None:
    pub = DetectionPublisher(redis=fake_redis)
    await pub.publish(_det(), correlation_id="corr-7")
    raw = fake_redis.broker.published[-1][1]
    envelope = json.loads(raw)
    assert envelope["correlation_id"] == "corr-7"


@pytest.mark.asyncio
async def test_publish_records_failure(fake_redis: FakeRedis) -> None:
    pub = DetectionPublisher(redis=fake_redis)

    async def boom(*_args: object, **_kw: object) -> int:
        raise RuntimeError("redis broker down")

    fake_redis.publish = boom  # type: ignore[assignment]
    with pytest.raises(RuntimeError):
        await pub.publish(_det())
    assert pub.counters.publish_errors == 1
    assert pub.counters.published == 0
