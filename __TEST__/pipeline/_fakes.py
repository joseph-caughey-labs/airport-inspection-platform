"""Async Redis fakes used by the ai-inference test suite.

The pytest fixtures in `conftest.py` instantiate these; tests import
the classes here directly when they need static reference (e.g. to
build an unhealthy variant in a test-local fixture).
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any


class FakePubSub:
    def __init__(self, broker: FakeBroker) -> None:
        self._broker = broker
        self._subscribed: set[str] = set()
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def subscribe(self, channel: str) -> None:
        self._subscribed.add(channel)
        self._broker.attach(channel, self._queue)

    async def unsubscribe(self, channel: str) -> None:
        self._subscribed.discard(channel)
        self._broker.detach(channel, self._queue)

    async def close(self) -> None:
        for ch in list(self._subscribed):
            await self.unsubscribe(ch)

    async def listen(self):  # type: ignore[no-untyped-def]
        while True:
            item = await self._queue.get()
            yield item


class FakeBroker:
    def __init__(self) -> None:
        self._listeners: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)
        self.published: list[tuple[str, str]] = []

    def attach(self, channel: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._listeners[channel].append(queue)

    def detach(self, channel: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        if queue in self._listeners.get(channel, []):
            self._listeners[channel].remove(queue)

    async def publish(self, channel: str, data: str) -> int:
        self.published.append((channel, data))
        for q in self._listeners.get(channel, []):
            await q.put({"type": "message", "channel": channel, "data": data})
        return len(self._listeners.get(channel, []))


class FakeRedis:
    def __init__(
        self,
        broker: FakeBroker | None = None,
        ping_result: Any = "PONG",
        ping_exception: BaseException | None = None,
    ) -> None:
        self._broker = broker or FakeBroker()
        self._ping_result = ping_result
        self._ping_exception = ping_exception
        self._pubsubs: list[FakePubSub] = []

    @property
    def broker(self) -> FakeBroker:
        return self._broker

    async def ping(self) -> Any:
        if self._ping_exception is not None:
            raise self._ping_exception
        return self._ping_result

    async def publish(self, channel: str, data: str) -> int:
        return await self._broker.publish(channel, data)

    def pubsub(self) -> FakePubSub:
        ps = FakePubSub(self._broker)
        self._pubsubs.append(ps)
        return ps
