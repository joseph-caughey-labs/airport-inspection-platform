"""Wildlife detector — simulated species classification.

Classifies airport-relevant species and rates severity by species
risk × proximity to the active runway. SOP thresholds come from
`data/seed/reference/sop-baseline.json`:

    wildlife.high_risk_classes:           ["deer", "coyote", "large_bird"]
    wildlife.alert_within_runway_buffer_m: 200

Severity matrix:
    high-risk + within buffer → critical
    high-risk + outside buffer → high
    low-risk + within buffer  → medium
    low-risk + outside buffer → low

Fixture truth contract:

    metadata.fixture_truth.wildlife = {
        "present": true,
        "species": "deer" | "coyote" | "large_bird" | "small_bird" | ...,
        "distance_to_runway_m": float,
        "bbox": { x, y, w, h },              # optional
        "base_confidence": 0..1              # optional, default 0.84
    }

`detection_class` is always "wildlife"; the species lives in
`metadata.species` so adding a new species never widens the channel
taxonomy.
"""

from __future__ import annotations

import json
import random
import uuid
from pathlib import Path
from typing import Any, Final

from ..models import BoundingBox, DetectionPayload, SensorFrameEvent, SeverityHint

DEFAULT_HIGH_RISK_CLASSES: Final[tuple[str, ...]] = ("deer", "coyote", "large_bird")
DEFAULT_RUNWAY_BUFFER_M: Final[float] = 200.0


class WildlifeDetector:
    """Wildlife presence + species classification detector."""

    name = "wildlife"
    applicable_sensor_types: Final[tuple[str, ...]] = ("camera",)

    def __init__(
        self,
        seed: int = 0,
        high_risk_classes: tuple[str, ...] | None = None,
        runway_buffer_m: float = DEFAULT_RUNWAY_BUFFER_M,
        confidence_jitter: float = 0.04,
        bbox_jitter: float = 0.01,
        noise_rate: float = 0.0,
        noise_confidence_max: float = 0.4,
    ) -> None:
        if not 0 <= noise_rate <= 1:
            raise ValueError("noise_rate must be within [0, 1]")
        if not 0 <= confidence_jitter < 0.5:
            raise ValueError("confidence_jitter must be within [0, 0.5)")
        if runway_buffer_m <= 0:
            raise ValueError("runway_buffer_m must be > 0")
        self._high_risk = frozenset(high_risk_classes or DEFAULT_HIGH_RISK_CLASSES)
        self._runway_buffer_m = runway_buffer_m
        self._rng = random.Random(seed)
        self._confidence_jitter = confidence_jitter
        self._bbox_jitter = bbox_jitter
        self._noise_rate = noise_rate
        self._noise_confidence_max = noise_confidence_max

    @property
    def high_risk_classes(self) -> frozenset[str]:
        return self._high_risk

    @property
    def runway_buffer_m(self) -> float:
        return self._runway_buffer_m

    async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        truth = _read_wildlife_truth(frame.payload.metadata)
        if truth is None:
            return self._maybe_noise(frame)
        return [self._build_truth_detection(frame, truth)]

    def _build_truth_detection(
        self,
        frame: SensorFrameEvent,
        truth: _WildlifeTruth,
    ) -> DetectionPayload:
        base = truth.base_confidence
        confidence = self._clamp_unit(
            base + self._rng.uniform(-self._confidence_jitter, self._confidence_jitter)
        )
        severity = self._severity_for(truth)
        bbox = self._jitter_bbox(truth.bbox) if truth.bbox is not None else None
        metadata: dict[str, Any] = {
            "species": truth.species,
            "high_risk": truth.species in self._high_risk,
            "fixture_truth": True,
        }
        if truth.distance_to_runway_m is not None:
            metadata["distance_to_runway_m"] = truth.distance_to_runway_m
            metadata["within_runway_buffer"] = truth.distance_to_runway_m <= self._runway_buffer_m
        return DetectionPayload(
            detection_id=str(uuid.UUID(int=self._rng.getrandbits(128), version=4)),
            sensor_id=frame.payload.sensor_id,
            frame_id=frame.payload.frame_id,
            detection_class="wildlife",
            confidence=confidence,
            severity_hint=severity,
            bbox=bbox,
            captured_at=frame.payload.captured_at,
            geo=frame.payload.geo,
            metadata=metadata,
        )

    def _severity_for(self, truth: _WildlifeTruth) -> SeverityHint:
        high_risk = truth.species in self._high_risk
        within_buffer = (
            truth.distance_to_runway_m is not None
            and truth.distance_to_runway_m <= self._runway_buffer_m
        )
        if high_risk and within_buffer:
            return "critical"
        if high_risk:
            return "high"
        if within_buffer:
            return "medium"
        return "low"

    def _maybe_noise(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        if self._noise_rate <= 0 or self._rng.random() >= self._noise_rate:
            return []
        confidence = self._rng.uniform(0.1, self._noise_confidence_max)
        return [
            DetectionPayload(
                detection_id=str(uuid.UUID(int=self._rng.getrandbits(128), version=4)),
                sensor_id=frame.payload.sensor_id,
                frame_id=frame.payload.frame_id,
                detection_class="wildlife",
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


class _WildlifeTruth:
    __slots__ = ("species", "distance_to_runway_m", "bbox", "base_confidence")

    def __init__(
        self,
        species: str,
        distance_to_runway_m: float | None,
        bbox: BoundingBox | None,
        base_confidence: float,
    ) -> None:
        self.species = species
        self.distance_to_runway_m = distance_to_runway_m
        self.bbox = bbox
        self.base_confidence = base_confidence


def _read_wildlife_truth(metadata: dict[str, Any]) -> _WildlifeTruth | None:
    fixture_truth = metadata.get("fixture_truth")
    if not isinstance(fixture_truth, dict):
        return None
    wild = fixture_truth.get("wildlife")
    if not isinstance(wild, dict) or not wild.get("present"):
        return None
    species = wild.get("species")
    if not isinstance(species, str) or not species:
        return None
    raw_dist = wild.get("distance_to_runway_m")
    distance_to_runway_m: float | None = None
    if isinstance(raw_dist, int | float) and raw_dist >= 0:
        distance_to_runway_m = float(raw_dist)
    raw_bbox = wild.get("bbox")
    bbox: BoundingBox | None = None
    if isinstance(raw_bbox, dict):
        try:
            bbox = BoundingBox.model_validate(raw_bbox)
        except (ValueError, TypeError):
            bbox = None
    base_confidence = wild.get("base_confidence", 0.84)
    if not isinstance(base_confidence, int | float):
        base_confidence = 0.84
    return _WildlifeTruth(
        species=species,
        distance_to_runway_m=distance_to_runway_m,
        bbox=bbox,
        base_confidence=float(base_confidence),
    )


def load_wildlife_thresholds(
    path: Path | str,
) -> tuple[tuple[str, ...], float]:
    """Reads `wildlife.high_risk_classes` + `alert_within_runway_buffer_m`
    from sop-baseline.json. Falls back to defaults on missing file /
    block / bad types."""
    p = Path(path)
    if not p.is_file():
        return DEFAULT_HIGH_RISK_CLASSES, DEFAULT_RUNWAY_BUFFER_M
    raw = json.loads(p.read_text(encoding="utf-8"))
    section = raw.get("wildlife") if isinstance(raw, dict) else None
    if not isinstance(section, dict):
        return DEFAULT_HIGH_RISK_CLASSES, DEFAULT_RUNWAY_BUFFER_M
    species_raw = section.get("high_risk_classes", list(DEFAULT_HIGH_RISK_CLASSES))
    species: tuple[str, ...]
    if isinstance(species_raw, list) and all(isinstance(s, str) for s in species_raw):
        species = tuple(species_raw)
    else:
        species = DEFAULT_HIGH_RISK_CLASSES
    buffer_raw = section.get("alert_within_runway_buffer_m", DEFAULT_RUNWAY_BUFFER_M)
    buffer_m = (
        float(buffer_raw)
        if isinstance(buffer_raw, int | float) and buffer_raw > 0
        else DEFAULT_RUNWAY_BUFFER_M
    )
    return species, buffer_m
