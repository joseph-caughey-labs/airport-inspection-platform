"""Confidence calibration + weather degradation + temporal smoothing."""

from .calibration import (
    DEFAULT_DEGRADATION_FACTOR,
    DEFAULT_LOW_VISIBILITY_FACTOR,
    DEFAULT_WEATHER_DEGRADATION_M,
    DEFAULT_WEATHER_LOW_VISIBILITY_M,
    CalibrationConfig,
    Calibrator,
    WeatherDegradation,
    load_weather_degradation,
)
from .smoothing import (
    DEFAULT_SMOOTHED_CLASSES,
    DEFAULT_THRESHOLD,
    DEFAULT_WINDOW_SIZE,
    SmoothingCounters,
    TemporalSmoother,
)

__all__ = [
    "DEFAULT_DEGRADATION_FACTOR",
    "DEFAULT_LOW_VISIBILITY_FACTOR",
    "DEFAULT_SMOOTHED_CLASSES",
    "DEFAULT_THRESHOLD",
    "DEFAULT_WEATHER_DEGRADATION_M",
    "DEFAULT_WEATHER_LOW_VISIBILITY_M",
    "DEFAULT_WINDOW_SIZE",
    "CalibrationConfig",
    "Calibrator",
    "SmoothingCounters",
    "TemporalSmoother",
    "WeatherDegradation",
    "load_weather_degradation",
]
