"""Composes the AI service runtime.

Stages (in order):
    consumer  → optional batcher → orchestrator → calibrator → publisher

The batcher (T-307) is opt-in via `RuntimeConfig.batching_enabled`.
When disabled, frames flow per-frame through `handle_frame`. When
enabled, frames are submitted to a `BatchScheduler` that flushes on
size or timeout, and each batch goes through `handle_batch` — which
runs the same orchestrator + calibrator + publisher chain but tags
every detection with the batch_id.

This is the only place where the components meet. Each is
independently testable; the runtime exists so `main.py` (and the
docker entrypoint) has one thing to start + stop, and so the
correlation_id flows end-to-end without leaking the wire concerns
into the orchestrator or detectors.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import redis.asyncio as redis_async

from ..confidence import Calibrator
from ..consumers import FrameConsumer
from ..detectors import DetectorRegistry
from ..models import DetectionPayload, SensorFrameEvent
from ..publishers import DetectionPublisher
from .batch import BatchContext, BatchScheduler
from .config import RuntimeConfig
from .orchestrator import DetectorOrchestrator


@dataclass
class RuntimeCounters:
    """Per-runtime counters not owned by a specific component."""

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
            handler=self._on_consumer_frame,
            channel=config.frame_channel,
            max_concurrent=config.max_concurrent,
            logger=self._logger,
        )
        # Identity calibrator by default — T-302..T-305 detectors keep
        # producing the same numbers until app.py registers a
        # configured one.
        self.calibrator = calibrator if calibrator is not None else Calibrator()
        self.counters = RuntimeCounters()
        self.batch_scheduler: BatchScheduler | None = None
        if config.batching_enabled:
            self.batch_scheduler = BatchScheduler(
                dispatch=self.handle_batch,
                batch_size=config.batch_size,
                timeout_ms=config.batch_timeout_ms,
                logger=self._logger,
            )

    async def _on_consumer_frame(self, frame: SensorFrameEvent) -> None:
        """Routes a single frame through batching or per-frame
        dispatch based on config. Kept private so the per-frame and
        batch handler entry points stay independently testable."""
        if self.batch_scheduler is not None:
            await self.batch_scheduler.submit(frame)
            return
        await self.handle_frame(frame)

    async def handle_frame(self, frame: SensorFrameEvent) -> None:
        """Per-frame inference path. Tests use this directly to skip
        the consumer + batcher wiring."""
        detections = await self.orchestrator.dispatch(frame)
        await self._calibrate_and_publish(frame, detections, batch_id=None)

    async def handle_batch(
        self,
        frames: list[SensorFrameEvent],
        ctx: BatchContext,
    ) -> None:
        """Batch inference path. Every detection emitted from frames
        in this batch records `metadata.batch.id` so downstream
        consumers can correlate them."""
        for frame in frames:
            detections = await self.orchestrator.dispatch(frame)
            await self._calibrate_and_publish(frame, detections, batch_id=ctx.batch_id)

    async def _calibrate_and_publish(
        self,
        frame: SensorFrameEvent,
        detections: list[DetectionPayload],
        batch_id: str | None,
    ) -> None:
        frame_meta = frame.payload.metadata
        for detection in detections:
            calibrated = self.calibrator.apply(detection, frame_meta)
            if calibrated is None:
                self.counters.detections_dropped_by_calibration += 1
                continue
            if batch_id is not None:
                meta = dict(calibrated.metadata)
                meta["batch"] = {"id": batch_id}
                calibrated = calibrated.model_copy(update={"metadata": meta})
            # Correlation propagation: detection events carry the same
            # correlation_id as the inbound frame so the audit trail
            # is threadable end-to-end.
            await self.publisher.publish(calibrated, correlation_id=frame.correlation_id)
            self.counters.detections_published += 1

    async def start(self) -> None:
        if self.batch_scheduler is not None:
            await self.batch_scheduler.start()
        await self.consumer.start()
        self._logger.info(
            "ai-runtime started: detectors=%s channel=%s batching=%s",
            self.orchestrator._registry.names(),  # noqa: SLF001 — internal logging convenience
            self._config.frame_channel,
            self._config.batching_enabled,
        )

    async def stop(self) -> None:
        await self.consumer.stop()
        if self.batch_scheduler is not None:
            await self.batch_scheduler.stop()
        self._logger.info("ai-runtime stopped")

    async def run_until_cancelled(self) -> None:
        """Convenience for `main.py` — start + sleep forever; cancel
        propagates to stop()."""
        await self.start()
        try:
            await asyncio.Event().wait()
        finally:
            await self.stop()
