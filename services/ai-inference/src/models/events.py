"""Pydantic mirrors of the TypeScript shared-contracts schemas.

These models are the single funnel between the Redis wire format and
the runtime — every frame that survives the consumer becomes one of
these typed objects, every detection the publisher emits is built from
one. The detector orchestrator never touches raw JSON.

Cross-language contract: the field names + types here must match
`packages/shared-contracts/src/events/{envelope,sensor-frame}.ts`.
The pytest suite in `__TEST__/pipeline/test_models.py` round-trips
sample envelopes from the TS reference fixtures to catch drift.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SENSOR_TYPES = ("camera", "lidar", "gps", "imu", "weather", "perimeter")
SCHEMA_VERSION_RE = re.compile(r"^v\d+(\.\d+)?$")


class EventSource(BaseModel):
    """Originating service identity for an envelope."""

    model_config = ConfigDict(extra="forbid")

    service: str = Field(min_length=1)
    instance_id: str | None = Field(default=None, min_length=1)


class EventEnvelope(BaseModel):
    """Base envelope. Concrete events extend with a typed `payload`."""

    model_config = ConfigDict(extra="forbid")

    event_id: str
    event_type: str = Field(min_length=1)
    schema_version: str
    source: EventSource
    timestamp: datetime
    correlation_id: str | None = None
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("schema_version")
    @classmethod
    def _validate_schema_version(cls, v: str) -> str:
        if not SCHEMA_VERSION_RE.match(v):
            raise ValueError(r"schema_version must match v\d+(.\d+)?")
        return v


class GeoPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    alt_m: float | None = None


class SensorFramePayload(BaseModel):
    """Per-frame data shape — matches `SensorFramePayload` in TS."""

    model_config = ConfigDict(extra="forbid")

    sensor_id: str = Field(min_length=1, max_length=64)
    sensor_type: Literal["camera", "lidar", "gps", "imu", "weather", "perimeter"]
    frame_id: str = Field(min_length=1, max_length=128)
    captured_at: datetime
    geo: GeoPoint
    metadata: dict[str, Any] = Field(default_factory=dict)


class SensorFrameEvent(EventEnvelope):
    """Full sensor-frame envelope as emitted on `sensor.frame.captured`."""

    event_type: Literal["sensor.frame.captured"] = "sensor.frame.captured"
    payload: SensorFramePayload


class BoundingBox(BaseModel):
    """Normalized image-space bbox — [0,1] in both axes. Pixel-relative
    boxes get scaled at the camera level so detector outputs stay
    resolution-independent (T-2xx camera sim emits the resolution in
    `metadata.width/height`)."""

    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)


DetectionClass = Literal[
    "fod",
    "crack",
    "snowbank",
    "wildlife",
    "anomaly",
]


SeverityHint = Literal["critical", "high", "medium", "low", "info"]


class DetectionPayload(BaseModel):
    """One detection produced by an AI detector for a single frame."""

    model_config = ConfigDict(extra="forbid")

    detection_id: str
    sensor_id: str = Field(min_length=1, max_length=64)
    frame_id: str = Field(min_length=1, max_length=128)
    detection_class: DetectionClass
    confidence: float = Field(ge=0, le=1)
    severity_hint: SeverityHint
    bbox: BoundingBox | None = None
    captured_at: datetime
    geo: GeoPoint | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class DetectionEvent(EventEnvelope):
    """Envelope published on `ai.detection.<class>.emitted`."""

    event_type: str = Field(pattern=r"^ai\.detection\.[a-z_]+\.emitted$")
    payload: DetectionPayload


def utc_now() -> datetime:
    """Convenience for tests + publishers that need a tz-aware now()."""
    return datetime.now(UTC)
