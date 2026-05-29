"""Composes the AI service runtime: consumer → orchestrator → publisher.

This is the only place where the four components meet (consumer,
orchestrator, calibrator, publisher). Each is independently testable;
the runtime exists so `main.py` (and the docker entrypoint) has one
thing to start + stop, and so the correlation id flows end-to-end
without leaking the wire concerns into the orchestrator or detectors.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import redis.asyncio as redis_async

from ..confidence import Calibrator
from ..consumers import FrameConsumer
from ..detectors import DetectorRegistry
from ..models import SensorFrameEvent
from ..publishers import DetectionPublisher
from .config import RuntimeConfig
from .orchestrator import DetectorOrchestrator


@dataclass
class RuntimeCounters:
    """Per-runtime counters not owned by a specific component (e.g.
    detections dropped by calibration vs. detections actually
    published)."""

    detections_published: int = 0
    detections_dropped_by_calibration: int = 0


class AiRuntime:
    """Single-process runtime that drains the sensor frame channel and
    pushes detections back onto Redis. Held by `main.py` for the
    lifetime of the service.

    Tests can construct an AiRuntime with handcrafted consumer +
    publisher + registry, then drive `handle_frame()` directly,
    bypassing Redis entirely (see `test_runtime.py`).
    """

    def __init__(
        self,
        redis: redis_async.Redis,
        registry: DetectorRegistry,
        config: RuntimeConfig,
        calibrator: Calibrator | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._config = config
        self._logger = logger or logging.getLogger("ai-inference.runtime")
        self.orchestrator = DetectorOrchestrator(
            registry=registry,
            parallel=config.parallel_detectors,
            logger=self._logger,
        )
        self.publisher = DetectionPublisher(
            redis=redis,
            service_name=config.service_name,
            instance_id=config.instance_id,
            schema_version=config.schema_version,
            logger=self._logger,
        )
        self.consumer = FrameConsumer(
            redis=redis,
            handler=self.handle_frame,
            channel=config.frame_channel,
            max_concurrent=config.max_concurrent,
            logger=self._logger,
        )
        # Identity calibrator by default — T-302..T-305 detectors keep
        # producing the same numbers until app.py registers a
        # configured one.
        self.calibrator = calibrator if calibrator is not None else Calibrator()
        self.counters = RuntimeCounters()

    async def handle_frame(self, frame: SensorFrameEvent) -> None:
        """Inner handler — exposed for tests so they don't need a
        live Redis subscriber to exercise the dispatch path."""
        detections = await self.orchestrator.dispatch(frame)
        # Calibration runs between dispatch and publish. Detections
        # that calibrate below min_publish_threshold are dropped here
        # rather than at the publisher (the publisher's role is wire
        # encoding, not decision-making).
        frame_meta = frame.payload.metadata
        for detection in detections:
            calibrated = self.calibrator.apply(detection, frame_meta)
            if calibrated is None:
                self.counters.detections_dropped_by_calibration += 1
                continue
            # Correlation propagation: detection events carry the same
            # correlation_id as the inbound frame so the audit trail
            # is threadable end-to-end.
            await self.publisher.publish(calibrated, correlation_id=frame.correlation_id)
            self.counters.detections_published += 1

    async def start(self) -> None:
        await self.consumer.start()
        self._logger.info(
            "ai-runtime started: detectors=%s channel=%s",
            self.orchestrator._registry.names(),  # noqa: SLF001 — internal logging convenience
            self._config.frame_channel,
        )

    async def stop(self) -> None:
        await self.consumer.stop()
        self._logger.info("ai-runtime stopped")

    async def run_until_cancelled(self) -> None:
        """Convenience for `main.py` — start + sleep forever; cancel
        propagates to stop()."""
        await self.start()
        try:
            await asyncio.Event().wait()
        finally:
            await self.stop()
