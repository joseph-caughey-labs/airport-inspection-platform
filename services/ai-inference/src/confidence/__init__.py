"""Confidence calibration + weather degradation."""

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

__all__ = [
    "DEFAULT_DEGRADATION_FACTOR",
    "DEFAULT_LOW_VISIBILITY_FACTOR",
    "DEFAULT_WEATHER_DEGRADATION_M",
    "DEFAULT_WEATHER_LOW_VISIBILITY_M",
    "CalibrationConfig",
    "Calibrator",
    "WeatherDegradation",
    "load_weather_degradation",
]
