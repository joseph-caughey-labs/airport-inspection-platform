"""Confidence calibration + weather degradation.

Two transforms run, in this order, between the orchestrator and the
publisher:

  1. **Per-detector linear calibration** —
     `calibrated = clamp01(slope * raw + intercept)`. The identity
     transform is the default (slope=1, intercept=0); detectors that
     systematically overshoot (or undershoot) precision on the fixture
     set get a non-identity entry. The intent is that a calibrated
     score of 0.7 reflects ~70% precision when evaluated against the
     fixture-truth ground truth.

  2. **Weather degradation modifier** — if the frame metadata
     reports a `visibility_m` below the SOP's degradation threshold,
     confidence is multiplied by `degradation_factor` (default 0.7).
     Below the *hard* low-visibility threshold the modifier flips to
     `low_visibility_factor` (default 0.5). This is what drives the
     "weather-degraded confidence" scenario 06 (T-311).

Calibration NEVER raises severity — it can only DOWNGRADE confidence.
A detection whose calibrated confidence falls below a per-detector
`min_publish_threshold` is dropped from the publish path entirely
(returned by `Calibrator.apply` as `None`). The reviewer queue still
sees these because the orchestrator counts them on a separate metric
in T-403.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from ..models import DetectionPayload

DEFAULT_WEATHER_LOW_VISIBILITY_M: Final[float] = 800.0
DEFAULT_WEATHER_DEGRADATION_M: Final[float] = 1200.0
DEFAULT_DEGRADATION_FACTOR: Final[float] = 0.7
DEFAULT_LOW_VISIBILITY_FACTOR: Final[float] = 0.5


@dataclass(frozen=True)
class CalibrationConfig:
    """Per-detector linear calibration + publish threshold."""

    slope: float = 1.0
    intercept: float = 0.0
    min_publish_threshold: float = 0.0

    def __post_init__(self) -> None:
        if self.slope <= 0:
            raise ValueError("slope must be > 0")
        if not 0 <= self.min_publish_threshold <= 1:
            raise ValueError("min_publish_threshold must be within [0, 1]")


@dataclass(frozen=True)
class WeatherDegradation:
    """Weather-driven confidence multiplier."""

    low_visibility_threshold_m: float = DEFAULT_WEATHER_LOW_VISIBILITY_M
    degradation_threshold_m: float = DEFAULT_WEATHER_DEGRADATION_M
    degradation_factor: float = DEFAULT_DEGRADATION_FACTOR
    low_visibility_factor: float = DEFAULT_LOW_VISIBILITY_FACTOR

    def __post_init__(self) -> None:
        for label, v in (
            ("low_visibility_threshold_m", self.low_visibility_threshold_m),
            ("degradation_threshold_m", self.degradation_threshold_m),
        ):
            if v <= 0:
                raise ValueError(f"{label} must be > 0")
        if self.degradation_threshold_m <= self.low_visibility_threshold_m:
            raise ValueError(
                "degradation_threshold_m must be greater than low_visibility_threshold_m"
            )
        for label, v in (
            ("degradation_factor", self.degradation_factor),
            ("low_visibility_factor", self.low_visibility_factor),
        ):
            if not 0 < v <= 1:
                raise ValueError(f"{label} must be within (0, 1]")
        if self.low_visibility_factor > self.degradation_factor:
            raise ValueError("low_visibility_factor must be ≤ degradation_factor")

    def factor_for(self, visibility_m: float | None) -> float:
        """Returns the multiplicative confidence factor for a given
        visibility reading. None / unparseable readings → 1.0."""
        if visibility_m is None or visibility_m < 0:
            return 1.0
        if visibility_m < self.low_visibility_threshold_m:
            return self.low_visibility_factor
        if visibility_m < self.degradation_threshold_m:
            return self.degradation_factor
        return 1.0


@dataclass
class Calibrator:
    """Owns per-detector calibration + a single weather modifier."""

    weather: WeatherDegradation = field(default_factory=WeatherDegradation)
    per_detector: dict[str, CalibrationConfig] = field(default_factory=dict)
    logger: logging.Logger | None = None

    def apply(
        self,
        detection: DetectionPayload,
        frame_metadata: dict[str, Any] | None = None,
    ) -> DetectionPayload | None:
        """Returns the calibrated detection, or `None` if it falls
        below the per-detector `min_publish_threshold` after
        calibration. Calibration metadata is recorded under
        `metadata.calibration` so downstream consumers can audit the
        transform."""
        config = self.per_detector.get(detection.detection_class, CalibrationConfig())
        calibrated = max(0.0, min(1.0, config.slope * detection.confidence + config.intercept))
        weather_factor = self.weather.factor_for(_extract_visibility(frame_metadata))
        final = max(0.0, min(1.0, calibrated * weather_factor))
        if final < config.min_publish_threshold:
            return None
        meta = dict(detection.metadata)
        meta["calibration"] = {
            "raw_confidence": detection.confidence,
            "slope": config.slope,
            "intercept": config.intercept,
            "weather_factor": weather_factor,
            "final": final,
        }
        return detection.model_copy(update={"confidence": final, "metadata": meta})


def _extract_visibility(frame_metadata: dict[str, Any] | None) -> float | None:
    if not isinstance(frame_metadata, dict):
        return None
    weather = frame_metadata.get("weather")
    if not isinstance(weather, dict):
        return None
    raw = weather.get("visibility_m")
    if isinstance(raw, int | float) and raw >= 0:
        return float(raw)
    return None


def load_weather_degradation(path: Path | str) -> WeatherDegradation:
    """Reads the `weather` block from sop-baseline.json. Falls back to
    defaults on missing file / block / bad types. Logs nothing here —
    the caller logs the source so a flipped threshold shows up in
    operational logs at startup."""
    p = Path(path)
    if not p.is_file():
        return WeatherDegradation()
    raw = json.loads(p.read_text(encoding="utf-8"))
    section = raw.get("weather") if isinstance(raw, dict) else None
    if not isinstance(section, dict):
        return WeatherDegradation()
    low = section.get("low_visibility_threshold_m", DEFAULT_WEATHER_LOW_VISIBILITY_M)
    deg = section.get("confidence_degradation_threshold_m", DEFAULT_WEATHER_DEGRADATION_M)
    if not isinstance(low, int | float) or low <= 0:
        low = DEFAULT_WEATHER_LOW_VISIBILITY_M
    if not isinstance(deg, int | float) or deg <= low:
        deg = max(DEFAULT_WEATHER_DEGRADATION_M, float(low) * 1.5)
    return WeatherDegradation(
        low_visibility_threshold_m=float(low),
        degradation_threshold_m=float(deg),
    )
