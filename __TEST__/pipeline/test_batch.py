"""Batch inference scheduler — size + timeout flush, metrics."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

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
from src.pipeline import AiRuntime, BatchContext, BatchScheduler, RuntimeConfig


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


# ─── Scheduler unit tests ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_scheduler_flushes_on_full_batch() -> None:
    """AC: configurable batch size (default 8). Full-size batches
    dispatch immediately without waiting for the timeout."""
    received: list[tuple[list[SensorFrameEvent], BatchContext]] = []

    async def dispatch(frames: list[SensorFrameEvent], ctx: BatchContext) -> None:
        received.append((list(frames), ctx))

    scheduler = BatchScheduler(dispatch=dispatch, batch_size=3, timeout_ms=2000)
    await scheduler.start()
    try:
        for i in range(3):
            await scheduler.submit(_frame(frame_id=f"F-{i}"))
        # Wait briefly for the scheduler's run loop to pick up the batch.
        for _ in range(50):
            if received:
                break
            await asyncio.sleep(0.01)
    finally:
        await scheduler.stop()
    assert len(received) == 1
    frames, ctx = received[0]
    assert len(frames) == 3
    assert ctx.batch_size == 3
    assert scheduler.counters.full_batches == 1
    assert scheduler.counters.timeout_flushes == 0


@pytest.mark.asyncio
async def test_scheduler_flushes_on_timeout_with_partial_batch() -> None:
    """AC: falls back to per-frame if batch queue starves > timeout.
    A partial batch flushes after timeout_ms instead of waiting forever."""
    received: list[tuple[list[SensorFrameEvent], BatchContext]] = []

    async def dispatch(frames: list[SensorFrameEvent], ctx: BatchContext) -> None:
        received.append((list(frames), ctx))

    scheduler = BatchScheduler(dispatch=dispatch, batch_size=8, timeout_ms=100)
    await scheduler.start()
    try:
        await scheduler.submit(_frame(frame_id="F-A"))
        await scheduler.submit(_frame(frame_id="F-B"))
        # Wait for the timeout to fire and the run loop to pick it up.
        for _ in range(60):
            if received:
                break
            await asyncio.sleep(0.02)
    finally:
        await scheduler.stop()
    assert len(received) == 1
    frames, ctx = received[0]
    assert len(frames) == 2  # partial batch
    assert ctx.batch_size == 2
    assert scheduler.counters.timeout_flushes == 1
    assert scheduler.counters.full_batches == 0


@pytest.mark.asyncio
async def test_scheduler_single_frame_is_dispatched_after_timeout() -> None:
    """Single frame still flushes (size=1 batch). The system never
    starves a lone frame."""
    received: list[BatchContext] = []

    async def dispatch(frames: list[SensorFrameEvent], ctx: BatchContext) -> None:
        received.append(ctx)

    scheduler = BatchScheduler(dispatch=dispatch, batch_size=8, timeout_ms=80)
    await scheduler.start()
    try:
        await scheduler.submit(_frame())
        for _ in range(60):
            if received:
                break
            await asyncio.sleep(0.02)
    finally:
        await scheduler.stop()
    assert len(received) == 1
    assert received[0].batch_size == 1


@pytest.mark.asyncio
async def test_scheduler_records_batch_latency() -> None:
    """AC: batch latency metric emitted."""

    async def dispatch(frames: list[SensorFrameEvent], ctx: BatchContext) -> None:
        # Simulate inference latency.
        await asyncio.sleep(0.02)

    scheduler = BatchScheduler(dispatch=dispatch, batch_size=2, timeout_ms=500)
    await scheduler.start()
    try:
        await scheduler.submit(_frame("a"))
        await scheduler.submit(_frame("b"))
        for _ in range(60):
            if scheduler.counters.batches_dispatched > 0:
                break
            await asyncio.sleep(0.02)
    finally:
        await scheduler.stop()
    assert scheduler.counters.last_latency_ms >= 15  # ~20ms simulated work
    assert scheduler.counters.batches_dispatched == 1
    assert scheduler.counters.frames_batched == 2


@pytest.mark.asyncio
async def test_scheduler_uses_provided_id_factory() -> None:
    """Tests should be able to pin batch_id."""
    received: list[BatchContext] = []
    sequence = iter(["fixed-1", "fixed-2"])

    async def dispatch(frames: list[SensorFrameEvent], ctx: BatchContext) -> None:
        received.append(ctx)

    scheduler = BatchScheduler(
        dispatch=dispatch,
        batch_size=2,
        timeout_ms=200,
        id_factory=lambda: next(sequence),
    )
    await scheduler.start()
    try:
        await scheduler.submit(_frame("a"))
        await scheduler.submit(_frame("b"))
        for _ in range(50):
            if received:
                break
            await asyncio.sleep(0.02)
    finally:
        await scheduler.stop()
    assert received[0].batch_id == "fixed-1"


@pytest.mark.asyncio
async def test_scheduler_isolates_failing_dispatch() -> None:
    """A dispatch that raises must not kill the run loop."""
    received: list[BatchContext] = []
    call_count = 0

    async def dispatch(frames: list[SensorFrameEvent], ctx: BatchContext) -> None:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("first batch boom")
        received.append(ctx)

    scheduler = BatchScheduler(dispatch=dispatch, batch_size=1, timeout_ms=100)
    await scheduler.start()
    try:
        await scheduler.submit(_frame("a"))
        await scheduler.submit(_frame("b"))
        for _ in range(60):
            if received:
                break
            await asyncio.sleep(0.02)
    finally:
        await scheduler.stop()
    assert len(received) == 1


def test_scheduler_rejects_invalid_config() -> None:
    async def noop_dispatch(_f: list[SensorFrameEvent], _c: BatchContext) -> None:
        return None

    with pytest.raises(ValueError, match="batch_size"):
        BatchScheduler(dispatch=noop_dispatch, batch_size=0)
    with pytest.raises(ValueError, match="timeout_ms"):
        BatchScheduler(dispatch=noop_dispatch, timeout_ms=0)


def test_batch_context_latency_ms() -> None:
    ctx = BatchContext(batch_id="b-1", batch_size=4, started_at_monotonic=0.0)
    assert ctx.latency_ms(now=0.05) == pytest.approx(50.0)


# ─── Runtime integration tests ─────────────────────────────────────────


class _StubDetector:
    name = "stub-fod"
    applicable_sensor_types = ("camera",)

    async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        return [
            DetectionPayload(
                detection_id=f"det-{frame.payload.frame_id}",
                sensor_id=frame.payload.sensor_id,
                frame_id=frame.payload.frame_id,
                detection_class="fod",
                confidence=0.9,
                severity_hint="critical",
                captured_at=frame.payload.captured_at,
                geo=frame.payload.geo,
            )
        ]


@pytest.mark.asyncio
async def test_runtime_with_batching_disabled_uses_per_frame_path(
    fake_redis: FakeRedis,
    fake_broker: FakeBroker,
) -> None:
    """When batching_enabled=False, no batch metadata is attached."""
    registry = DetectorRegistry()
    registry.register(_StubDetector())
    runtime = AiRuntime(
        redis=fake_redis,
        registry=registry,
        config=RuntimeConfig(batching_enabled=False),
    )
    await runtime.handle_frame(_frame())
    # One frame, one detection emitted with no batch metadata.
    assert fake_broker.published[-1][0] == "ai.detection.fod.emitted"
    envelope = json.loads(fake_broker.published[-1][1])
    assert "batch" not in envelope["payload"]["metadata"]


@pytest.mark.asyncio
async def test_runtime_handle_batch_tags_every_detection_with_batch_id(
    fake_redis: FakeRedis,
    fake_broker: FakeBroker,
) -> None:
    """Direct call to handle_batch: all detections from the batch
    share the same batch_id in metadata."""
    registry = DetectorRegistry()
    registry.register(_StubDetector())
    runtime = AiRuntime(
        redis=fake_redis,
        registry=registry,
        config=RuntimeConfig(batching_enabled=True, batch_size=2, batch_timeout_ms=200),
    )
    ctx = BatchContext(batch_id="batch-X", batch_size=2, started_at_monotonic=0.0)
    await runtime.handle_batch([_frame("a"), _frame("b")], ctx)
    batches = [
        json.loads(payload)["payload"]["metadata"]["batch"]["id"]
        for ch, payload in fake_broker.published
        if ch.startswith("ai.detection.")
    ]
    assert batches == ["batch-X", "batch-X"]
    assert runtime.counters.detections_published == 2


@pytest.mark.asyncio
async def test_runtime_with_batching_enabled_dispatches_via_scheduler(
    fake_redis: FakeRedis,
    fake_broker: FakeBroker,
) -> None:
    """End-to-end: enabling batching routes consumer frames through
    the scheduler; detections carry batch ids."""
    registry = DetectorRegistry()
    registry.register(_StubDetector())
    runtime = AiRuntime(
        redis=fake_redis,
        registry=registry,
        config=RuntimeConfig(batching_enabled=True, batch_size=2, batch_timeout_ms=100),
    )
    assert runtime.batch_scheduler is not None
    await runtime.batch_scheduler.start()
    try:
        await runtime.batch_scheduler.submit(_frame("a"))
        await runtime.batch_scheduler.submit(_frame("b"))
        for _ in range(60):
            if runtime.counters.detections_published >= 2:
                break
            await asyncio.sleep(0.02)
    finally:
        await runtime.batch_scheduler.stop()
    assert runtime.counters.detections_published == 2
    assert runtime.batch_scheduler.counters.batches_dispatched == 1


@pytest.mark.asyncio
async def test_runtime_falls_back_to_single_frame_batch_after_timeout(
    fake_redis: FakeRedis,
    fake_broker: FakeBroker,
) -> None:
    """A lone frame in a batched runtime still publishes after the
    timeout. This is the AC: 'falls back to per-frame if batch queue
    starves > timeout' — interpreted as 'flush whatever you have'."""
    registry = DetectorRegistry()
    registry.register(_StubDetector())
    runtime = AiRuntime(
        redis=fake_redis,
        registry=registry,
        config=RuntimeConfig(batching_enabled=True, batch_size=8, batch_timeout_ms=80),
    )
    assert runtime.batch_scheduler is not None
    await runtime.batch_scheduler.start()
    try:
        await runtime.batch_scheduler.submit(_frame("solo"))
        for _ in range(60):
            if runtime.counters.detections_published >= 1:
                break
            await asyncio.sleep(0.02)
    finally:
        await runtime.batch_scheduler.stop()
    assert runtime.counters.detections_published == 1
    assert runtime.batch_scheduler.counters.timeout_flushes == 1


@pytest.mark.asyncio
async def test_runtime_config_threads_batch_settings_from_env(monkeypatch: Any) -> None:
    """RuntimeConfig.from_env wires the new env knobs."""
    monkeypatch.setenv("AI_BATCHING_ENABLED", "true")
    monkeypatch.setenv("AI_BATCH_SIZE", "12")
    monkeypatch.setenv("AI_BATCH_TIMEOUT_MS", "350")
    cfg = RuntimeConfig.from_env()
    assert cfg.batching_enabled is True
    assert cfg.batch_size == 12
    assert cfg.batch_timeout_ms == 350
