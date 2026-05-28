"""Pydantic envelope round-tripping.

Cross-language contract check: the JSON shapes the camera simulator
emits MUST parse cleanly through `SensorFrameEvent`, and the events
the publisher will emit MUST parse cleanly through `DetectionEvent`.
If this drifts from `packages/shared-contracts/src/events/*.ts` we
catch it here before integration.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from src.models import (
    BoundingBox,
    DetectionEvent,
    DetectionPayload,
    EventSource,
    GeoPoint,
    SensorFrameEvent,
)


def _frame_dict() -> dict[str, object]:
    return {
        "event_id": "11111111-2222-3333-4444-555555555555",
        "event_type": "sensor.frame.captured",
        "schema_version": "v1",
        "source": {"service": "sensor-gateway"},
        "timestamp": "2026-05-28T10:00:00.000Z",
        "idempotency_key": "frame:CAM-RWY10L-01-00000001",
        "payload": {
            "sensor_id": "CAM-RWY10L-01",
            "sensor_type": "camera",
            "frame_id": "CAM-RWY10L-01-00000001",
            "captured_at": "2026-05-28T10:00:00.000Z",
            "geo": {"lat": 37.6213, "lng": -122.379, "alt_m": 4},
            "metadata": {"width": 1920, "height": 1080},
        },
    }


def test_sensor_frame_event_parses_canonical_payload() -> None:
    event = SensorFrameEvent.model_validate(_frame_dict())
    assert event.payload.sensor_id == "CAM-RWY10L-01"
    assert event.payload.sensor_type == "camera"
    assert event.payload.geo.alt_m == 4
    assert event.idempotency_key == "frame:CAM-RWY10L-01-00000001"


def test_sensor_frame_event_rejects_bad_sensor_type() -> None:
    bad = _frame_dict()
    bad["payload"]["sensor_type"] = "ultrasound"  # type: ignore[index]
    with pytest.raises(ValidationError):
        SensorFrameEvent.model_validate(bad)


def test_sensor_frame_event_rejects_out_of_range_geo() -> None:
    bad = _frame_dict()
    bad["payload"]["geo"]["lat"] = 91  # type: ignore[index]
    with pytest.raises(ValidationError):
        SensorFrameEvent.model_validate(bad)


def test_sensor_frame_event_rejects_bad_schema_version() -> None:
    bad = _frame_dict()
    bad["schema_version"] = "1"  # missing leading v
    with pytest.raises(ValidationError):
        SensorFrameEvent.model_validate(bad)


def test_event_envelope_extra_fields_are_forbidden() -> None:
    bad = _frame_dict()
    bad["surprise"] = "field"
    with pytest.raises(ValidationError):
        SensorFrameEvent.model_validate(bad)


def test_detection_payload_round_trips() -> None:
    payload = DetectionPayload(
        detection_id="d-1",
        sensor_id="CAM-RWY10L-01",
        frame_id="F-1",
        detection_class="fod",
        confidence=0.87,
        severity_hint="critical",
        bbox=BoundingBox(x=0.1, y=0.2, w=0.3, h=0.4),
        captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        geo=GeoPoint(lat=37.62, lng=-122.37),
    )
    j = payload.model_dump_json()
    back = DetectionPayload.model_validate_json(j)
    assert back == payload


def test_detection_event_requires_publish_channel_shape_event_type() -> None:
    payload = DetectionPayload(
        detection_id="d-1",
        sensor_id="CAM-1",
        frame_id="F-1",
        detection_class="fod",
        confidence=0.9,
        severity_hint="high",
        captured_at=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
    )
    DetectionEvent(
        event_id="e-1",
        event_type="ai.detection.fod.emitted",
        schema_version="v1",
        source=EventSource(service="ai-inference"),
        timestamp=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
        payload=payload,
    )
    with pytest.raises(ValidationError):
        DetectionEvent(
            event_id="e-1",
            event_type="incident.created",  # wrong pattern
            schema_version="v1",
            source=EventSource(service="ai-inference"),
            timestamp=datetime(2026, 5, 28, 10, 0, tzinfo=UTC),
            payload=payload,
        )


def test_bounding_box_rejects_zero_or_negative_dimensions() -> None:
    with pytest.raises(ValidationError):
        BoundingBox(x=0.1, y=0.1, w=0.0, h=0.5)
    with pytest.raises(ValidationError):
        BoundingBox(x=0.1, y=0.1, w=0.5, h=-0.1)
