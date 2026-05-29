"""Redis pub/sub consumer for `sensor.frame.captured` envelopes.

Mirrors the Node side `RedisSubscriber` pattern in
`services/event-pipeline/src/consumers/subscriber.ts`:

  - One dedicated subscriber connection (pub/sub forbids issuing
    commands on the same connection).
  - Decode the raw JSON to a `SensorFrameEvent` Pydantic model BEFORE
    dispatch. Malformed payloads count to a metric and drop; they do
    not reach the orchestrator.
  - Backpressure: a configurable max_concurrent in-flight dispatch
    cap. New messages wait on a bounded asyncio.Semaphore.

The consumer doesn't know about detectors. The runtime composer wires
the dispatch callback in `runtime.py` to the orchestrator.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import redis.asyncio as redis_async
from pydantic import ValidationError

from ..models import SensorFrameEvent

FrameHandler = Callable[[SensorFrameEvent], Awaitable[None]]

DEFAULT_CHANNEL = "sensor.frame.captured"
DEFAULT_MAX_CONCURRENT = 16


@dataclass
class ConsumerCounters:
    """Lightweight in-memory counters. Wired into prom-client at the
    runtime composition layer so detector + publisher metrics can
    share a single CollectorRegistry."""

    received: int = 0
    dispatched: int = 0
    decode_errors: int = 0
    handler_errors: int = 0


class FrameConsumer:
    """Subscribes to the sensor-frame channel and dispatches typed
    events to a single handler.

    Lifecycle:
        c = FrameConsumer(redis=client, handler=on_frame)
        await c.start()           # spawns the listen task
        ...
        await c.stop()            # cancels + drains in-flight tasks
    """

    def __init__(
        self,
        redis: redis_async.Redis,
        handler: FrameHandler,
        channel: str = DEFAULT_CHANNEL,
        max_concurrent: int = DEFAULT_MAX_CONCURRENT,
        logger: logging.Logger | None = None,
    ) -> None:
        self._redis = redis
        self._handler = handler
        self._channel = channel
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._logger = logger or logging.getLogger("ai-inference.frame-consumer")
        self._task: asyncio.Task[None] | None = None
        self._pubsub: redis_async.client.PubSub | None = None
        self._in_flight: set[asyncio.Task[None]] = set()
        self.counters = ConsumerCounters()

    @property
    def channel(self) -> str:
        return self._channel

    async def start(self) -> None:
        if self._task is not None:
            return
        self._pubsub = self._redis.pubsub()
        await self._pubsub.subscribe(self._channel)
        self._task = asyncio.create_task(self._listen(), name="frame-consumer-listen")
        self._logger.info("frame-consumer subscribed to %s", self._channel)

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        # Drain in-flight handlers — bounded by max_concurrent.
        if self._in_flight:
            await asyncio.gather(*self._in_flight, return_exceptions=True)
        if self._pubsub is not None:
            await self._pubsub.unsubscribe(self._channel)
            await self._pubsub.close()
            self._pubsub = None

    async def _listen(self) -> None:
        assert self._pubsub is not None
        async for raw_message in self._pubsub.listen():
            if raw_message.get("type") != "message":
                continue
            self.counters.received += 1
            data = raw_message.get("data")
            if data is None:
                self.counters.decode_errors += 1
                continue
            await self._dispatch(data if isinstance(data, str) else data.decode("utf-8"))

    async def _dispatch(self, raw: str) -> None:
        try:
            event = SensorFrameEvent.model_validate_json(raw)
        except ValidationError as err:
            self.counters.decode_errors += 1
            self._logger.warning("frame-consumer decode error: %s", err)
            return
        await self._semaphore.acquire()
        task = asyncio.create_task(self._run_handler(event))
        self._in_flight.add(task)
        task.add_done_callback(self._on_task_done)

    async def _run_handler(self, event: SensorFrameEvent) -> None:
        try:
            await self._handler(event)
            self.counters.dispatched += 1
        except Exception:  # noqa: BLE001 — handler isolation; failure is logged + counted
            self.counters.handler_errors += 1
            self._logger.exception(
                "frame-consumer handler raised for frame %s", event.payload.frame_id
            )
        finally:
            self._semaphore.release()

    def _on_task_done(self, task: asyncio.Task[None]) -> None:
        self._in_flight.discard(task)
