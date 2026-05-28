"""Detector orchestrator.

Takes one frame and dispatches it to every detector in the registry
whose `applicable_sensor_types` includes the frame's sensor_type.
Detector failures are isolated — one detector raising never breaks
the others. Detection lists from all detectors are flattened into a
single list returned to the caller.

Concurrency: by default detectors for a single frame run sequentially
because their CPU cost is the dominant variable and Python's GIL plus
asyncio give us no real parallelism gain from running them concurrently
for pure-Python work. Set `parallel=True` to gather them via
`asyncio.gather` (useful once we add I/O-bound detectors — see T-307
batch inference).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from ..detectors import DetectorRegistry
from ..models import DetectionPayload, SensorFrameEvent


@dataclass
class OrchestratorCounters:
    frames_received: int = 0
    detections_emitted: int = 0
    detector_errors: int = 0
    skipped_no_detectors: int = 0


class DetectorOrchestrator:
    def __init__(
        self,
        registry: DetectorRegistry,
        parallel: bool = False,
        logger: logging.Logger | None = None,
    ) -> None:
        self._registry = registry
        self._parallel = parallel
        self._logger = logger or logging.getLogger("ai-inference.orchestrator")
        self.counters = OrchestratorCounters()

    async def dispatch(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        self.counters.frames_received += 1
        detectors = self._registry.applicable_to(frame.payload.sensor_type)
        if not detectors:
            self.counters.skipped_no_detectors += 1
            return []
        if self._parallel:
            results = await asyncio.gather(
                *(self._run_one(d, frame) for d in detectors),
                return_exceptions=False,
            )
        else:
            results = []
            for d in detectors:
                results.append(await self._run_one(d, frame))
        flattened: list[DetectionPayload] = []
        for batch in results:
            flattened.extend(batch)
        self.counters.detections_emitted += len(flattened)
        return flattened

    async def _run_one(
        self,
        detector: Any,
        frame: SensorFrameEvent,
    ) -> list[DetectionPayload]:
        try:
            result: list[DetectionPayload] = await detector.detect(frame)
            return result
        except Exception:  # noqa: BLE001 — detector isolation
            self.counters.detector_errors += 1
            self._logger.exception(
                "detector %s raised on frame %s",
                getattr(detector, "name", "?"),
                frame.payload.frame_id,
            )
            return []
