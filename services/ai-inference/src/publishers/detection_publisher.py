"""Publishes `DetectionPayload`s to Redis on `ai.detection.<class>.emitted`.

The publisher is the only thing that knows about the wire format. The
orchestrator + detectors hand it typed Pydantic models; the publisher
wraps each detection in the canonical `DetectionEvent` envelope and
ships it.

Idempotency: the publisher derives `idempotency_key` as
`detection:<sensor_id>:<frame_id>:<detection_class>` so the downstream
event-pipeline dedup window collapses duplicate detections from
re-processing the same frame.

Channel naming: matches the `@aip/redis-client` convention
(`buildChannelName(domain, entity, action)`) — `ai.detection.<class>`.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

import redis.asyncio as redis_async

from ..models import DetectionEvent, DetectionPayload, EventSource, utc_now


@dataclass
class PublisherCounters:
    published: int = 0
    publish_errors: int = 0


class DetectionPublisher:
    def __init__(
        self,
        redis: redis_async.Redis,
        service_name: str = "ai-inference",
        schema_version: str = "v1",
        instance_id: str | None = None,
        clock: Callable[[], datetime] | None = None,
        id_factory: Callable[[], str] | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._redis = redis
        self._service_name = service_name
        self._schema_version = schema_version
        self._instance_id = instance_id
        self._clock = clock or utc_now
        self._id_factory = id_factory or (lambda: str(uuid.uuid4()))
        self._logger = logger or logging.getLogger("ai-inference.publisher")
        self.counters = PublisherCounters()

    async def publish(
        self,
        detection: DetectionPayload,
        correlation_id: str | None = None,
    ) -> str:
        """Wrap a single detection in an envelope and publish. Returns
        the channel it was published on so callers can assert."""
        envelope = self._build_envelope(detection, correlation_id)
        channel = self._channel_for(detection)
        try:
            await self._redis.publish(channel, envelope.model_dump_json(by_alias=False))
            self.counters.published += 1
            return channel
        except Exception:  # noqa: BLE001 — log + count; retry policy lives upstream
            self.counters.publish_errors += 1
            self._logger.exception(
                "publish failed for detection %s on channel %s",
                detection.detection_id,
                channel,
            )
            raise

    def _channel_for(self, detection: DetectionPayload) -> str:
        return f"ai.detection.{detection.detection_class}.emitted"

    def _build_envelope(
        self,
        detection: DetectionPayload,
        correlation_id: str | None,
    ) -> DetectionEvent:
        source = EventSource(
            service=self._service_name,
            instance_id=self._instance_id,
        )
        return DetectionEvent(
            event_id=self._id_factory(),
            event_type=f"ai.detection.{detection.detection_class}.emitted",
            schema_version=self._schema_version,
            source=source,
            timestamp=self._clock(),
            correlation_id=correlation_id,
            idempotency_key=(
                f"detection:{detection.sensor_id}:"
                f"{detection.frame_id}:{detection.detection_class}"
            ),
            payload=detection,
        )
