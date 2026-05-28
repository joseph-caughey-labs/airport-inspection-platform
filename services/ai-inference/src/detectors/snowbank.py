"""Snowbank compliance detector — simulated.

Reads a `fixture_truth.snowbank` block describing a measured snowbank
(height in cm, setback in meters from the nearest runway/taxiway
edge) and compares those measurements against SOP thresholds.
A snowbank is *compliant* iff height ≤ max_height_cm AND setback ≥
the location's required minimum. Compliant snowbanks emit no
detection (a "clean" snowbank isn't an incident). Non-compliant
snowbanks emit one detection per snowbank, with `metadata.violations`
listing every threshold that failed.

SOP thresholds come from `data/seed/reference/sop-baseline.json` —
the caller loads them via `load_snowbank_thresholds()` and passes the
result to the detector. Tests can substitute their own thresholds
directly so a SOP change never silently invalidates the test fixture.

Truth contract:

    metadata.fixture_truth.snowbank = {
        "present": true,
        "location_class": "runway" | "taxiway" | "apron",
        "height_cm": float,                # measured at the apex
        "setback_m": float,                # distance to edge
        "bbox": { x, y, w, h },            # optional
        "base_confidence": 0..1            # optional, default 0.82
    }

Violation types (encoded as constants):
    "height_exceeded"
    "setback_runway"
    "setback_taxiway"
    "setback_unknown_location"  (location not recognized but setback
                                 fell below the strictest threshold)

Severity hint follows the location:
    runway  → critical
    taxiway → high
    apron   → medium
    other   → medium
"""

from __future__ import annotations

import json
import random
import uuid
from pathlib import Path
from typing import Any, Final, Literal

from ..models import BoundingBox, DetectionPayload, SensorFrameEvent, SeverityHint

LocationClass = Literal["runway", "taxiway", "apron"]

_LOCATION_SEVERITY: Final[dict[str, SeverityHint]] = {
    "runway": "critical",
    "taxiway": "high",
    "apron": "medium",
}
_UNKNOWN_LOCATION_SEVERITY: SeverityHint = "medium"


# Default thresholds — mirror sop-baseline.json so a missing file
# never breaks the runtime; the test suite asserts these match.
DEFAULT_SOP_THRESHOLDS: Final[dict[str, float]] = {
    "max_height_cm": 240.0,
    "runway_setback_min_m": 6.0,
    "taxiway_setback_min_m": 3.0,
}


class SnowbankDetector:
    """Snowbank height + setback compliance detector."""

    name = "snowbank"
    applicable_sensor_types: Final[tuple[str, ...]] = ("camera",)

    def __init__(
        self,
        seed: int = 0,
        thresholds: dict[str, float] | None = None,
        confidence_jitter: float = 0.04,
        bbox_jitter: float = 0.01,
        noise_rate: float = 0.0,
        noise_confidence_max: float = 0.4,
    ) -> None:
        if not 0 <= noise_rate <= 1:
            raise ValueError("noise_rate must be within [0, 1]")
        if not 0 <= confidence_jitter < 0.5:
            raise ValueError("confidence_jitter must be within [0, 0.5)")
        thr = {**DEFAULT_SOP_THRESHOLDS, **(thresholds or {})}
        for key in ("max_height_cm", "runway_setback_min_m", "taxiway_setback_min_m"):
            if thr[key] <= 0:
                raise ValueError(f"threshold {key} must be > 0")
        self._thresholds = thr
        self._rng = random.Random(seed)
        self._confidence_jitter = confidence_jitter
        self._bbox_jitter = bbox_jitter
        self._noise_rate = noise_rate
        self._noise_confidence_max = noise_confidence_max

    @property
    def thresholds(self) -> dict[str, float]:
        return dict(self._thresholds)

    async def detect(self, frame: SensorFrameEvent) -> list[DetectionPayload]:
        truth = _read_snowbank_truth(frame.payload.metadata)
        if truth is None:
            return self._maybe_noise(frame)
        violations = self._classify_violations(truth)
        if not violations:
            # Compliant — explicitly no detection emitted.
            return []
        return [self._build_truth_detection(frame, truth, violations)]

    def _classify_violations(self, truth: _SnowbankTruth) -> list[str]:
        violations: list[str] = []
        if truth.height_cm is not None and truth.height_cm > self._thresholds["max_height_cm"]:
            violations.append("height_exceeded")
        if truth.setback_m is not None:
            if truth.location_class == "runway":
                if truth.setback_m < self._thresholds["runway_setback_min_m"]:
                    violations.append("setback_runway")
            elif truth.location_class == "taxiway":
                if truth.setback_m < self._thresholds["taxiway_setback_min_m"]:
                    violations.append("setback_taxiway")
            else:
                # Unknown location — use the strictest threshold so a
                # mislabeled fixture isn't accidentally rated compliant.
                strictest = max(
                    self._thresholds["runway_setback_min_m"],
                    self._thresholds["taxiway_setback_min_m"],
                )
                if truth.setback_m < strictest:
                    violations.append("setback_unknown_location")
        return violations

    def _build_truth_detection(
        self,
        frame: SensorFrameEvent,
        truth: _SnowbankTruth,
        violations: list[str],
    ) -> DetectionPayload:
        base = truth.base_confidence
        confidence = self._clamp_unit(
            base + self._rng.uniform(-self._confidence_jitter, self._confidence_jitter)
        )
        severity = _LOCATION_SEVERITY.get(truth.location_class, _UNKNOWN_LOCATION_SEVERITY)
        bbox = self._jitter_bbox(truth.bbox) if truth.bbox is not None else None
        metadata: dict[str, Any] = {
            "location_class": truth.location_class,
            "violations": violations,
            "fixture_truth": True,
            "thresholds": dict(self._thresholds),
        }
        if truth.height_cm is not None:
            metadata["height_cm"] = truth.height_cm
        if truth.setback_m is not None:
            metadata["setback_m"] = truth.setback_m
        return DetectionPayload(
            detection_id=str(uuid.UUID(int=self._rng.getrandbits(128), version=4)),
            sensor_id=frame.payload.sensor_id,
            frame_id=frame.payload.frame_id,
            detection_class="snowbank",
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
                detection_class="snowbank",
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


class _SnowbankTruth:
    __slots__ = ("location_class", "height_cm", "setback_m", "bbox", "base_confidence")

    def __init__(
        self,
        location_class: str,
        height_cm: float | None,
        setback_m: float | None,
        bbox: BoundingBox | None,
        base_confidence: float,
    ) -> None:
        self.location_class = location_class
        self.height_cm = height_cm
        self.setback_m = setback_m
        self.bbox = bbox
        self.base_confidence = base_confidence


def _read_snowbank_truth(metadata: dict[str, Any]) -> _SnowbankTruth | None:
    fixture_truth = metadata.get("fixture_truth")
    if not isinstance(fixture_truth, dict):
        return None
    snow = fixture_truth.get("snowbank")
    if not isinstance(snow, dict) or not snow.get("present"):
        return None
    location_class = snow.get("location_class", "unknown")
    if not isinstance(location_class, str):
        location_class = "unknown"
    height_cm = _coerce_nonneg(snow.get("height_cm"))
    setback_m = _coerce_nonneg(snow.get("setback_m"))
    raw_bbox = snow.get("bbox")
    bbox: BoundingBox | None = None
    if isinstance(raw_bbox, dict):
        try:
            bbox = BoundingBox.model_validate(raw_bbox)
        except (ValueError, TypeError):
            bbox = None
    base_confidence = snow.get("base_confidence", 0.82)
    if not isinstance(base_confidence, int | float):
        base_confidence = 0.82
    return _SnowbankTruth(
        location_class=location_class,
        height_cm=height_cm,
        setback_m=setback_m,
        bbox=bbox,
        base_confidence=float(base_confidence),
    )


def _coerce_nonneg(value: Any) -> float | None:
    if not isinstance(value, int | float):
        return None
    if value < 0:
        return None
    return float(value)


def load_snowbank_thresholds(path: Path | str) -> dict[str, float]:
    """Reads `data/seed/reference/sop-baseline.json` and pulls just
    the snowbank block. Missing file or missing block falls back to
    `DEFAULT_SOP_THRESHOLDS`. Caller logs the source so a flipped
    threshold shows up in operational logs at startup."""
    p = Path(path)
    if not p.is_file():
        return dict(DEFAULT_SOP_THRESHOLDS)
    raw = json.loads(p.read_text(encoding="utf-8"))
    section = raw.get("snowbank") if isinstance(raw, dict) else None
    if not isinstance(section, dict):
        return dict(DEFAULT_SOP_THRESHOLDS)
    out = dict(DEFAULT_SOP_THRESHOLDS)
    for key in DEFAULT_SOP_THRESHOLDS:
        v = section.get(key)
        if isinstance(v, int | float) and v > 0:
            out[key] = float(v)
    return out
