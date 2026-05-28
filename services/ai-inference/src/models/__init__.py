"""Pydantic models for the AI inference runtime."""

from .events import (
    BoundingBox,
    DetectionClass,
    DetectionEvent,
    DetectionPayload,
    EventEnvelope,
    EventSource,
    GeoPoint,
    SensorFrameEvent,
    SensorFramePayload,
    SeverityHint,
    utc_now,
)

__all__ = [
    "BoundingBox",
    "DetectionClass",
    "DetectionEvent",
    "DetectionPayload",
    "EventEnvelope",
    "EventSource",
    "GeoPoint",
    "SensorFrameEvent",
    "SensorFramePayload",
    "SeverityHint",
    "utc_now",
]
