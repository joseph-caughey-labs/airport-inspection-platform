"""Pavement crack detector — simulated.

Classifies into longitudinal, transverse, alligator. Severity band
classification follows the Domain Expert SOP:

    Longitudinal / transverse:
        width < 6mm    → low
        6mm ≤ width < 19mm → medium
        width ≥ 19mm   → high

    Alligator (interconnected, indicates structural failure):
        any width      → high  baseline
        width ≥ 19mm   → critical

Fixture truth contract (sibling of `fod` under `fixture_truth`):

    metadata.fixture_truth.crack = {
        "present": true,
        "crack_type": "longitudinal" | "transverse" | "alligator",
        "width_mm": float,           # optional, drives severity band
        "bbox":     { x, y, w, h },  # optional
        "base_confidence": 0..1      # optional, default 0.85
    }

The detection envelope's `detection_class` is always `"crack"`; the
specific subtype lives in `metadata.crack_type` so downstream
consumers can route on subtype without inflating the channel
taxonomy.
"""

from __future__ import annotations

import random
import uuid
from typing import Any, Final, Literal

from ..models import BoundingBox, DetectionPayload, SensorFrameEvent, SeverityHint

CrackType = Literal["longitudinal", "transverse", "alligator"]
_CRACK_TYPES: Final[tuple[CrackType, ...]] = ("longitudinal", "transverse", "alligator")

_LINEAR_THRESHOLDS_MM: Final[tuple[float, float]] = (6.0, 19.0)


def _severity_for(crack_type: str, width_mm: float | None) -> SeverityHint:
    """Domain Expert SOP, encoded once and exercised by tests."""
    if crack_type == "alligator":
        if width_mm is not None and width_mm >= _LINEAR_THRESHOLDS_MM[1]:
            return "critical"
        return "high"
    # Linear classes (longitudinal, transverse). Unknown subtypes
    # default to the linear scale rather than alligator's harsher
    # baseline so a typo doesn't quietly inflate the criticality.
    if width_mm is None or width_mm < _LINEAR_THRESHOLDS_MM[0]:
        return "low"
    if width_mm < _LINEAR_THRESHOLDS_MM[1]:
        return "medium"
    return "high"


class CrackDetector:
    """Pavement crack distress detector. Single instance per process."""

    name = "crack"
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
        truth = _read_crack_truth(frame.payload.metadata)
        if truth is None:
            return self._maybe_noise(frame)
        return [self._build_truth_detection(frame, truth)]

    def _build_truth_detection(
        self,
        frame: SensorFrameEvent,
        truth: _CrackTruth,
    ) -> DetectionPayload:
        base = truth.base_confidence
        confidence = self._clamp_unit(
            base + self._rng.uniform(-self._confidence_jitter, self._confidence_jitter)
        )
        severity = _severity_for(truth.crack_type, truth.width_mm)
        bbox = self._jitter_bbox(truth.bbox) if truth.bbox is not None else None
        metadata: dict[str, Any] = {
            "crack_type": truth.crack_type,
            "fixture_truth": True,
        }
        if truth.width_mm is not None:
            metadata["width_mm"] = truth.width_mm
        return DetectionPayload(
            detection_id=str(uuid.UUID(int=self._rng.getrandbits(128), version=4)),
            sensor_id=frame.payload.sensor_id,
            frame_id=frame.payload.frame_id,
            detection_class="crack",
            confidence=confidence,
            severity_hint=severity,
            bbox=bbox,
            captured_at=frame.payload.captured_at,
            geo=frame.payload.geo,
            metadata=metadata,
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
                detection_class="crack",
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


class _CrackTruth:
    __slots__ = ("crack_type", "width_mm", "bbox", "base_confidence")

    def __init__(
        self,
        crack_type: str,
        width_mm: float | None,
        bbox: BoundingBox | None,
        base_confidence: float,
    ) -> None:
        self.crack_type = crack_type
        self.width_mm = width_mm
        self.bbox = bbox
        self.base_confidence = base_confidence


def _read_crack_truth(metadata: dict[str, Any]) -> _CrackTruth | None:
    fixture_truth = metadata.get("fixture_truth")
    if not isinstance(fixture_truth, dict):
        return None
    crack = fixture_truth.get("crack")
    if not isinstance(crack, dict) or not crack.get("present"):
        return None
    crack_type = crack.get("crack_type", "longitudinal")
    if crack_type not in _CRACK_TYPES:
        # Unknown subtype — bail rather than silently rate it.
        return None
    raw_width = crack.get("width_mm")
    width_mm: float | None = None
    if isinstance(raw_width, int | float) and raw_width >= 0:
        width_mm = float(raw_width)
    raw_bbox = crack.get("bbox")
    bbox: BoundingBox | None = None
    if isinstance(raw_bbox, dict):
        try:
            bbox = BoundingBox.model_validate(raw_bbox)
        except (ValueError, TypeError):
            bbox = None
    base_confidence = crack.get("base_confidence", 0.85)
    if not isinstance(base_confidence, int | float):
        base_confidence = 0.85
    return _CrackTruth(
        crack_type=crack_type,
        width_mm=width_mm,
        bbox=bbox,
        base_confidence=float(base_confidence),
    )
