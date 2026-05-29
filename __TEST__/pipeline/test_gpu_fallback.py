"""GPU-unavailable fallback simulation — mode controller, runtime
metadata tagging, and admin HTTP endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import UTC, datetime

import pytest
from _fakes import FakeBroker, FakeRedis
from fastapi.testclient import TestClient

from src.app import build_app
from src.detectors import DetectorRegistry
from src.fallback import (
    DEFAULT_CPU_FALLBACK_LATENCY_MS,
    DEFAULT_GPU_LATENCY_MS,
    RuntimeModeController,
)
from src.models import (
    DetectionPayload,
    EventSource,
    GeoPoint,
    SensorFrameEvent,
    SensorFramePayload,
)
from src.pipeline import AiRuntime, RuntimeConfig


def _frame(frame_id: str = "F-1") -> SensorFrameEvent:
    return SensorFrameEvent(
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
                confidence=0.9,
                severity_hint="critical",
                captured_at=frame.payload.captured_at,
                geo=frame.payload.geo,
            )
        ]


# ─── RuntimeModeController unit ───────────────────────────────────────


def test_controller_defaults_to_gpu_mode() -> None:
    c = RuntimeModeController()
    assert c.current == "gpu"
    assert c.profile.simulate_latency_ms == DEFAULT_GPU_LATENCY_MS
    assert c.last_reason == "initial"


def test_snapshot_returns_serializable_dict() -> None:
    c = RuntimeModeController()
    snap = c.snapshot()
    # Must round-trip through JSON for the admin endpoint.
    json.dumps(snap)
    assert snap["mode"] == "gpu"
    assert snap["latency_ms"] == DEFAULT_GPU_LATENCY_MS
    assert "since_seconds" in snap


def test_constructor_rejects_invalid_latency() -> None:
    with pytest.raises(ValueError, match="latency_ms"):
        RuntimeModeController(gpu_latency_ms=-1)
    with pytest.raises(ValueError, match="cpu_fallback_latency_ms"):
        RuntimeModeController(gpu_latency_ms=20, cpu_fallback_latency_ms=10)
    with pytest.raises(ValueError, match="unknown initial_mode"):
        RuntimeModeController(initial_mode="cuda")  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_set_mode_transitions_and_records_reason() -> None:
    """AC: toggling GPU state mid-run cleanly switches mode."""
    c = RuntimeModeController()
    changed = await c.set_mode("cpu_fallback", "GPU thermal throttle")
    assert changed is True
    assert c.current == "cpu_fallback"
    assert c.profile.simulate_latency_ms == DEFAULT_CPU_FALLBACK_LATENCY_MS
    assert c.last_reason == "GPU thermal throttle"


@pytest.mark.asyncio
async def test_set_mode_same_mode_returns_false_and_keeps_reason() -> None:
    c = RuntimeModeController(initial_mode="cpu_fallback")
    changed = await c.set_mode("cpu_fallback", "manual retest")
    assert changed is False
    assert c.last_reason == "manual retest"


@pytest.mark.asyncio
async def test_set_mode_rejects_unknown_mode() -> None:
    c = RuntimeModeController()
    with pytest.raises(ValueError, match="unknown mode"):
        await c.set_mode("auto", "ignored")  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_logging_emits_reason_on_transition(caplog: pytest.LogCaptureFixture) -> None:
    """AC: logs the switch with reason."""
    c = RuntimeModeController()
    with caplog.at_level(logging.WARNING, logger="ai-inference.runtime-mode"):
        await c.set_mode("cpu_fallback", "thermal_alert")
    transition_records = [r for r in caplog.records if "transition" in r.message]
    assert transition_records
    msg = transition_records[0].message
    assert "thermal_alert" in msg
    assert "previous=gpu" in msg
    assert "next=cpu_fallback" in msg


@pytest.mark.asyncio
async def test_apply_latency_off_by_default_runs_immediately() -> None:
    c = RuntimeModeController(cpu_fallback_latency_ms=50)
    await c.set_mode("cpu_fallback", "test")
    start = time.monotonic()
    await c.apply_latency()
    # Should not sleep at all when simulate_latency=False (default).
    assert (time.monotonic() - start) < 0.01


@pytest.mark.asyncio
async def test_apply_latency_sleeps_when_simulated() -> None:
    c = RuntimeModeController(
        gpu_latency_ms=0,
        cpu_fallback_latency_ms=30,
        simulate_latency=True,
    )
    await c.set_mode("cpu_fallback", "stress test")
    start = time.monotonic()
    await c.apply_latency()
    elapsed_ms = (time.monotonic() - start) * 1000
    assert elapsed_ms >= 20


# ─── Runtime: metadata tagging ────────────────────────────────────────


@pytest.mark.asyncio
async def test_runtime_tags_detections_with_gpu_mode_by_default(
    fake_redis: FakeRedis, fake_broker: FakeBroker
) -> None:
    registry = DetectorRegistry()
    registry.register(_StubDetector())
    runtime = AiRuntime(redis=fake_redis, registry=registry, config=RuntimeConfig())
    await runtime.handle_frame(_frame())
    envelope = json.loads(fake_broker.published[-1][1])
    meta = envelope["payload"]["metadata"]
    assert meta["mode"] == "gpu"
    assert meta["mode_latency_ms"] == DEFAULT_GPU_LATENCY_MS


@pytest.mark.asyncio
async def test_runtime_tags_detections_with_cpu_fallback_after_toggle(
    fake_redis: FakeRedis, fake_broker: FakeBroker
) -> None:
    """AC: fallback events tagged `mode: cpu_fallback` in metadata."""
    registry = DetectorRegistry()
    registry.register(_StubDetector())
    runtime = AiRuntime(redis=fake_redis, registry=registry, config=RuntimeConfig())
    await runtime.mode_controller.set_mode("cpu_fallback", "thermal_alert")
    await runtime.handle_frame(_frame("with-cpu"))
    envelope = json.loads(fake_broker.published[-1][1])
    meta = envelope["payload"]["metadata"]
    assert meta["mode"] == "cpu_fallback"
    assert meta["mode_latency_ms"] == DEFAULT_CPU_FALLBACK_LATENCY_MS


@pytest.mark.asyncio
async def test_runtime_reads_mode_at_emit_time_for_mid_flight_toggle(
    fake_redis: FakeRedis, fake_broker: FakeBroker
) -> None:
    """A flip between handling two frames must affect the second emit."""
    registry = DetectorRegistry()
    registry.register(_StubDetector())
    runtime = AiRuntime(redis=fake_redis, registry=registry, config=RuntimeConfig())
    await runtime.handle_frame(_frame("F-gpu"))
    await runtime.mode_controller.set_mode("cpu_fallback", "manual_toggle")
    await runtime.handle_frame(_frame("F-cpu"))
    modes = []
    for ch, payload in fake_broker.published:
        if not ch.startswith("ai.detection."):
            continue
        modes.append(json.loads(payload)["payload"]["metadata"]["mode"])
    assert modes == ["gpu", "cpu_fallback"]


@pytest.mark.asyncio
async def test_runtime_accepts_external_mode_controller(
    fake_redis: FakeRedis, fake_broker: FakeBroker
) -> None:
    """Constructor-injected controller is honored."""
    external = RuntimeModeController(initial_mode="cpu_fallback")
    runtime = AiRuntime(
        redis=fake_redis,
        registry=DetectorRegistry(),
        config=RuntimeConfig(),
        mode_controller=external,
    )
    assert runtime.mode_controller is external
    assert runtime.mode_controller.current == "cpu_fallback"


# ─── Admin HTTP endpoint ──────────────────────────────────────────────


def _client(redis: FakeRedis | None = None) -> TestClient:
    return TestClient(build_app(redis_client=redis or FakeRedis()))


def test_admin_get_returns_current_mode() -> None:
    with _client() as c:
        r = c.get("/admin/gpu-state")
        assert r.status_code == 200
        body = r.json()
        assert body["mode"] == "gpu"
        assert body["last_reason"] == "initial"


def test_admin_post_toggles_to_cpu_fallback() -> None:
    with _client() as c:
        r = c.post(
            "/admin/gpu-state",
            json={"mode": "cpu_fallback", "reason": "thermal_alert"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["mode"] == "cpu_fallback"
        assert body["last_reason"] == "thermal_alert"
        assert body["changed"] is True
        # Subsequent GET reflects the new state.
        assert c.get("/admin/gpu-state").json()["mode"] == "cpu_fallback"


def test_admin_post_idempotent_same_mode_returns_changed_false() -> None:
    with _client() as c:
        first = c.post("/admin/gpu-state", json={"mode": "cpu_fallback", "reason": "first"}).json()
        assert first["changed"] is True
        second = c.post(
            "/admin/gpu-state", json={"mode": "cpu_fallback", "reason": "second"}
        ).json()
        assert second["changed"] is False
        # Reason still recorded for audit.
        assert second["last_reason"] == "second"


def test_admin_post_rejects_invalid_mode() -> None:
    with _client() as c:
        r = c.post("/admin/gpu-state", json={"mode": "cuda", "reason": "test"})
        assert r.status_code == 422  # pydantic validation


def test_admin_post_rejects_missing_reason() -> None:
    with _client() as c:
        r = c.post("/admin/gpu-state", json={"mode": "gpu"})
        assert r.status_code == 422


def test_admin_post_rejects_empty_reason() -> None:
    with _client() as c:
        r = c.post("/admin/gpu-state", json={"mode": "gpu", "reason": ""})
        assert r.status_code == 422


@pytest.mark.asyncio
async def test_concurrent_toggles_serialize_through_lock() -> None:
    c = RuntimeModeController()
    results = await asyncio.gather(
        c.set_mode("cpu_fallback", "a"),
        c.set_mode("gpu", "b"),
        c.set_mode("cpu_fallback", "c"),
    )
    # At least one transition fired; the controller never crashes
    # under concurrent set_mode calls.
    assert any(results)
    assert c.current in ("gpu", "cpu_fallback")
