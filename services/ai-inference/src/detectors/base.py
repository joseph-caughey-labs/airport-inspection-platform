"""Detector protocol + registry.

A detector is the smallest unit of inference. It takes ONE frame and
returns zero or more `DetectionPayload`s. Detectors do NOT publish to
Redis — that's the runtime's job — so they remain pure, deterministic,
and unit-testable without any I/O fixture.

Concrete detector heads (FOD, crack, snowbank, wildlife, anomaly) land
in T-302 through T-305. T-301 ships the protocol + the registry so
those tickets only have to drop in their heads.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Protocol, runtime_checkable

from ..models import DetectionPayload, SensorFrameEvent


@runtime_checkable
class Detector(Protocol):
    """Single-frame inference unit.

    Implementations:
        - Must be deterministic for a given (frame, configured seed).
        - Should accept all sensor_types they cannot process and
          return [] rather than raise. The orchestrator filters by
          `applicable_sensor_types` first as a fast path.
        - Must NOT mutate the input frame.
    """

    @property
    def name(self) -> str:
        """Stable identifier — used in metric labels."""
        ...

    @property
    def applicable_sensor_types(self) -> tuple[str, ...]:
        """Sensor types this detector consumes (e.g. ("camera",))."""
        ...

    async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        """Run inference on a single frame. Pure given a seeded RNG."""
        ...


class DetectorRegistry:
    """Ordered set of detectors. Order matters for tests + metrics
    label cardinality (each detector name shows up as a label value).
    """

    def __init__(self) -> None:
        self._detectors: list[Detector] = []

    def register(self, detector: Detector) -> None:
        if any(d.name == detector.name for d in self._detectors):
            raise ValueError(f"detector {detector.name!r} already registered")
        self._detectors.append(detector)

    def names(self) -> list[str]:
        return [d.name for d in self._detectors]

    def applicable_to(self, sensor_type: str) -> list[Detector]:
        return [d for d in self._detectors if sensor_type in d.applicable_sensor_types]

    def __iter__(self) -> Iterator[Detector]:
        return iter(self._detectors)

    def __len__(self) -> int:
        return len(self._detectors)
