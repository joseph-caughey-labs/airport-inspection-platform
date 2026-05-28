"""Foreign Object Debris (FOD) detector — simulated.

Reads a `fixture_truth` block from `frame.payload.metadata` to decide
whether the frame contains FOD. Real detection would be an ONNX/TRT
model in front of a NMS pass; for a portfolio demo we drive
detection deterministically from per-frame ground truth, plus a
seeded confidence jitter so the same seed produces the same output
across runs.

Fixture truth contract (camera simulator + manual test frames both
emit this shape when present):

    metadata.fixture_truth.fod = {
        "present": true,
        "location": "runway" | "taxiway" | "apron",
        "bbox": { "x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1 },
        "base_confidence": 0..1   # optional, default 0.88
    }

Behavior:
    - present=true → emit one DetectionPayload with `bbox` jittered
      by ≤ `bbox_jitter`, confidence drawn from
      `base_confidence ± confidence_jitter`, severity per the
      `_LOCATION_SEVERITY` matrix.
    - present missing / present=false → emit nothing UNLESS
      `noise_rate` > 0 and the seeded RNG fires, in which case
      emit a low-confidence (< 0.4) decoy detection (the "false
      positive" the temporal smoother in T-309 will suppress).

Severity matrix (per Domain Expert role doc):
    runway   → critical
    taxiway  → high
    apron    → medium
"""

from __future__ import annotations

import random
import uuid
from typing import Any, Final

from ..models import (
    BoundingBox,
    DetectionPayload,
    SensorFrameEvent,
    SeverityHint,
)

_LOCATION_SEVERITY: Final[dict[str, SeverityHint]] = {
    "runway": "critical",
    "taxiway": "high",
    "apron": "medium",
}
_UNKNOWN_LOCATION_SEVERITY: SeverityHint = "medium"


class FodDetector:
    """Foreign Object Debris detector. Single instance per process."""

    name = "fod"
    applicable_sensor_types: Final[tuple[str, ...]] = ("camera",)

    def __init__(
        self,
        seed: int = 0,
        confidence_jitter: float = 0.04,
        bbox_jitter: float = 0.01,
        noise_rate: float = 0.0,
        noise_confidence_max: float = 0.4,
    ) -> None:
        if not 0 <= noise_rate <= 1:
            raise ValueError("noise_rate must be within [0, 1]")
        if not 0 <= confidence_jitter < 0.5:
            raise ValueError("confidence_jitter must be within [0, 0.5)")
        self._rng = random.Random(seed)
        self._confidence_jitter = confidence_jitter
        self._bbox_jitter = bbox_jitter
        self._noise_rate = noise_rate
        self._noise_confidence_max = noise_confidence_max

    async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        truth = _read_fod_truth(frame.payload.metadata)
        if truth is None:
            return self._maybe_noise(frame)
        return [self._build_truth_detection(frame, truth)]

    def _build_truth_detection(
        self,
        frame: SensorFrameEvent,
        truth: _FodTruth,
    ) -> DetectionPayload:
        base = truth.base_confidence
        confidence = self._clamp_unit(
            base + self._rng.uniform(-self._confidence_jitter, self._confidence_jitter)
        )
        severity = _LOCATION_SEVERITY.get(truth.location, _UNKNOWN_LOCATION_SEVERITY)
        bbox = self._jitter_bbox(truth.bbox) if truth.bbox is not None else None
        return DetectionPayload(
            detection_id=str(uuid.UUID(int=self._rng.getrandbits(128), version=4)),
            sensor_id=frame.payload.sensor_id,
            frame_id=frame.payload.frame_id,
            detection_class="fod",
            confidence=confidence,
            severity_hint=severity,
            bbox=bbox,
            captured_at=frame.payload.captured_at,
            geo=frame.payload.geo,
            metadata={
                "location": truth.location,
                "fixture_truth": True,
            },
        )

    def _maybe_noise(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        if self._noise_rate <= 0 or self._rng.random() >= self._noise_rate:
            return []
        confidence = self._rng.uniform(0.1, self._noise_confidence_max)
        return [
            DetectionPayload(
                detection_id=str(uuid.UUID(int=self._rng.getrandbits(128), version=4)),
                sensor_id=frame.payload.sensor_id,
                frame_id=frame.payload.frame_id,
                detection_class="fod",
                confidence=confidence,
                severity_hint="info",
                bbox=None,
                captured_at=frame.payload.captured_at,
                geo=frame.payload.geo,
                metadata={"fixture_truth": False, "noise": True},
            )
        ]

    def _jitter_bbox(self, bbox: BoundingBox) -> BoundingBox:
        return BoundingBox(
            x=self._clamp_unit(bbox.x + self._rng.uniform(-self._bbox_jitter, self._bbox_jitter)),
            y=self._clamp_unit(bbox.y + self._rng.uniform(-self._bbox_jitter, self._bbox_jitter)),
            w=max(0.001, min(1, bbox.w)),
            h=max(0.001, min(1, bbox.h)),
        )

    @staticmethod
    def _clamp_unit(v: float) -> float:
        return max(0.0, min(1.0, v))


class _FodTruth:
    """In-process projection of the fixture truth block. Kept local to
    this module — detectors don't share a truth schema because each
    detector's truth shape is different."""

    __slots__ = ("location", "bbox", "base_confidence")

    def __init__(self, location: str, bbox: BoundingBox | None, base_confidence: float) -> None:
        self.location = location
        self.bbox = bbox
        self.base_confidence = base_confidence


def _read_fod_truth(metadata: dict[str, Any]) -> _FodTruth | None:
    fixture_truth = metadata.get("fixture_truth")
    if not isinstance(fixture_truth, dict):
        return None
    fod = fixture_truth.get("fod")
    if not isinstance(fod, dict) or not fod.get("present"):
        return None
    location = fod.get("location", "unknown")
    if not isinstance(location, str):
        location = "unknown"
    raw_bbox = fod.get("bbox")
    bbox = None
    if isinstance(raw_bbox, dict):
        try:
            bbox = BoundingBox.model_validate(raw_bbox)
        except (ValueError, TypeError):
            bbox = None
    base_confidence = fod.get("base_confidence", 0.88)
    if not isinstance(base_confidence, int | float):
        base_confidence = 0.88
    return _FodTruth(
        location=location,
        bbox=bbox,
        base_confidence=float(base_confidence),
    )
