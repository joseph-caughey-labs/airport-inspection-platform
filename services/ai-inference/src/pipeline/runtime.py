"""Composes the AI service runtime: consumer → orchestrator → publisher.

This is the only place where the three components meet. Each is
independently testable; the runtime exists so `main.py` (and the
docker entrypoint) has one thing to start + stop, and so the
correlation id flows end-to-end without leaking the wire concerns
into the orchestrator or detectors.
"""

from __future__ import annotations

import asyncio
import logging

import redis.asyncio as redis_async

from ..consumers import FrameConsumer
from ..detectors import DetectorRegistry
from ..models import SensorFrameEvent
from ..publishers import DetectionPublisher
from .config import RuntimeConfig
from .orchestrator import DetectorOrchestrator


class AiRuntime:
    """Single-process runtime that drains the sensor frame channel and
    pushes detections back onto Redis. Held by `main.py` for the
    lifetime of the service.

    Tests can construct an AiRuntime with handcrafted consumer +
    publisher + registry, then drive `dispatch_frame()` directly,
    bypassing Redis entirely (see `test_runtime.py`).
    """

    def __init__(
        self,
        redis: redis_async.Redis,
        registry: DetectorRegistry,
        config: RuntimeConfig,
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

    async def handle_frame(self, frame: SensorFrameEvent) -> None:
        """Inner handler — exposed for tests so they don't need a
        live Redis subscriber to exercise the dispatch path."""
        detections = await self.orchestrator.dispatch(frame)
        # Correlation propagation: detection events carry the same
        # correlation_id as the inbound frame so the audit trail is
        # threadable end-to-end.
        for detection in detections:
            await self.publisher.publish(detection, correlation_id=frame.correlation_id)

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
