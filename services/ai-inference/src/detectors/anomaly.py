"""Generic anomaly detector — "unexpected foreground" without classification.

This head's job is uncertainty: it flags frames containing things the
other detectors cannot categorize, with deliberately LOW confidence so
the downstream HITL (human-in-the-loop) routing in Phase 4 can pull
them into a review queue without inflating the operator's alert load.

Truth contract:

    metadata.fixture_truth.anomaly = {
        "present": true,
        "foreground_score": 0..1,          # optional; drives confidence
        "bbox": { x, y, w, h },             # optional
    }

The detector's own confidence is always clamped to `confidence_max`
(default 0.6). The Phase 4 reviewer-queue routing keys on
`confidence < hitl_threshold` (T-403 wires the threshold; the
detector just guarantees its output stays under 0.6 so it always
falls into the queue).

severity_hint is always `info` — anomalies are not alarms, they're
"please look at this" markers.
"""

from __future__ import annotations

import random
import uuid
from typing import Any, Final

from ..models import BoundingBox, DetectionPayload, SensorFrameEvent


class AnomalyDetector:
    """Generic "unknown foreground" anomaly detector."""

    name = "anomaly"
    applicable_sensor_types: Final[tuple[str, ...]] = ("camera",)

    def __init__(
        self,
        seed: int = 0,
        confidence_max: float = 0.6,
        confidence_min: float = 0.2,
        bbox_jitter: float = 0.01,
    ) -> None:
        if not 0 < confidence_max <= 1:
            raise ValueError("confidence_max must be within (0, 1]")
        if not 0 <= confidence_min < confidence_max:
            raise ValueError("confidence_min must be in [0, confidence_max)")
        self._confidence_max = confidence_max
        self._confidence_min = confidence_min
        self._bbox_jitter = bbox_jitter
        self._rng = random.Random(seed)

    @property
    def confidence_max(self) -> float:
        return self._confidence_max

    async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        truth = _read_anomaly_truth(frame.payload.metadata)
        if truth is None:
            return []
        # Confidence: if a foreground_score is provided we scale it
        # into the [min, max] band; otherwise we draw uniformly so the
        # output is deterministic given the seed.
        if truth.foreground_score is not None:
            scaled = self._confidence_min + truth.foreground_score * (
                self._confidence_max - self._confidence_min
            )
            confidence = max(self._confidence_min, min(self._confidence_max, scaled))
        else:
            confidence = self._rng.uniform(self._confidence_min, self._confidence_max)
        bbox = self._jitter_bbox(truth.bbox) if truth.bbox is not None else None
        return [
            DetectionPayload(
                detection_id=str(uuid.UUID(int=self._rng.getrandbits(128), version=4)),
                sensor_id=frame.payload.sensor_id,
                frame_id=frame.payload.frame_id,
                detection_class="anomaly",
                confidence=confidence,
                severity_hint="info",
                bbox=bbox,
                captured_at=frame.payload.captured_at,
                geo=frame.payload.geo,
                metadata={
                    "hitl_routing": True,
                    "confidence_band": [self._confidence_min, self._confidence_max],
                    "fixture_truth": True,
                },
            )
        ]

    def _jitter_bbox(self, bbox: BoundingBox) -> BoundingBox:
        jx = self._rng.uniform(-self._bbox_jitter, self._bbox_jitter)
        jy = self._rng.uniform(-self._bbox_jitter, self._bbox_jitter)
        return BoundingBox(
            x=max(0.0, min(1.0, bbox.x + jx)),
            y=max(0.0, min(1.0, bbox.y + jy)),
            w=max(0.001, min(1, bbox.w)),
            h=max(0.001, min(1, bbox.h)),
        )


class _AnomalyTruth:
    __slots__ = ("foreground_score", "bbox")

    def __init__(self, foreground_score: float | None, bbox: BoundingBox | None) -> None:
        self.foreground_score = foreground_score
        self.bbox = bbox


def _read_anomaly_truth(metadata: dict[str, Any]) -> _AnomalyTruth | None:
    fixture_truth = metadata.get("fixture_truth")
    if not isinstance(fixture_truth, dict):
        return None
    anom = fixture_truth.get("anomaly")
    if not isinstance(anom, dict) or not anom.get("present"):
        return None
    raw_score = anom.get("foreground_score")
    foreground_score: float | None = None
    if isinstance(raw_score, int | float) and 0 <= raw_score <= 1:
        foreground_score = float(raw_score)
    raw_bbox = anom.get("bbox")
    bbox: BoundingBox | None = None
    if isinstance(raw_bbox, dict):
        try:
            bbox = BoundingBox.model_validate(raw_bbox)
        except (ValueError, TypeError):
            bbox = None
    return _AnomalyTruth(foreground_score=foreground_score, bbox=bbox)
