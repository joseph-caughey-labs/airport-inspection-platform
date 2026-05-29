"""Batch inference scheduling.

Collects sensor frames into bounded batches and dispatches them
through a single callback. Sits between the FrameConsumer and the
orchestrator when `RuntimeConfig.batching_enabled` is True.

Flush triggers:
    1. Batch reaches `batch_size` (default 8).
    2. `timeout_ms` (default 200) elapses since the FIRST frame in
       the current batch arrived — that's the per-batch starvation
       budget. A single frame held for the full timeout still flushes
       as a batch of size 1; this is the "falls back to per-frame"
       acceptance criterion. The system continues making progress
       even when traffic is too low to fill a batch.

The dispatch callback receives the batch + a `BatchContext` carrying
the batch_id (uuid) and start timestamp. Every detection emitted from
frames in a batch should record `batch_id` so downstream consumers
can correlate them — that wiring lives in the runtime, not here.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from time import monotonic

from ..models import SensorFrameEvent

DEFAULT_BATCH_SIZE = 8
DEFAULT_TIMEOUT_MS = 200


@dataclass
class BatchContext:
    """Per-batch metadata handed to the dispatch callback."""

    batch_id: str
    batch_size: int
    started_at_monotonic: float

    def latency_ms(self, now: float | None = None) -> float:
        return ((now if now is not None else monotonic()) - self.started_at_monotonic) * 1000.0


@dataclass
class BatchCounters:
    batches_dispatched: int = 0
    frames_batched: int = 0
    full_batches: int = 0
    timeout_flushes: int = 0
    last_latency_ms: float = 0.0


BatchHandler = Callable[[list[SensorFrameEvent], BatchContext], Awaitable[None]]


class BatchScheduler:
    """Async batch collector + dispatcher.

    Usage:
        scheduler = BatchScheduler(dispatch=on_batch)
        await scheduler.start()
        ...
        await scheduler.submit(frame)
        ...
        await scheduler.stop()  # drains remaining frames

    The scheduler keeps ONE background task that loops over
    `_collect_batch()` calls. Each loop waits for at least one frame
    on the queue, then pulls up to `batch_size - 1` more frames within
    the timeout. Whatever it has — even a single frame — is dispatched.
    """

    def __init__(
        self,
        dispatch: BatchHandler,
        batch_size: int = DEFAULT_BATCH_SIZE,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        logger: logging.Logger | None = None,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be >= 1")
        if timeout_ms <= 0:
            raise ValueError("timeout_ms must be > 0")
        self._dispatch = dispatch
        self._batch_size = batch_size
        self._timeout_ms = timeout_ms
        self._logger = logger or logging.getLogger("ai-inference.batch")
        self._id_factory = id_factory or (lambda: str(uuid.uuid4()))
        self._clock = clock or monotonic
        self._queue: asyncio.Queue[SensorFrameEvent] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self.counters = BatchCounters()

    @property
    def batch_size(self) -> int:
        return self._batch_size

    @property
    def timeout_ms(self) -> int:
        return self._timeout_ms

    async def submit(self, frame: SensorFrameEvent) -> None:
        await self._queue.put(frame)

    async def start(self) -> None:
        if self._task is not None:
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="batch-scheduler")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._stop_event.set()
        # Wait for the current dispatch to finish; the loop exits when
        # the queue is empty AND _stop_event is set.
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        while not (self._stop_event.is_set() and self._queue.empty()):
            batch = await self._collect_batch()
            if not batch:
                continue
            await self._dispatch_one(batch)

    async def _collect_batch(self) -> list[SensorFrameEvent]:
        """Pulls one batch off the queue. Returns [] only when we're
        stopping AND the queue is drained."""
        try:
            # Wait for the first frame, but yield back to the run loop
            # periodically so a stop signal during low traffic doesn't
            # block forever.
            first = await asyncio.wait_for(self._queue.get(), timeout=0.5)
        except TimeoutError:
            return []
        batch: list[SensorFrameEvent] = [first]
        deadline = self._clock() + self._timeout_ms / 1000.0
        while len(batch) < self._batch_size:
            remaining = deadline - self._clock()
            if remaining <= 0:
                break
            try:
                next_frame = await asyncio.wait_for(self._queue.get(), timeout=remaining)
            except TimeoutError:
                break
            batch.append(next_frame)
        return batch

    async def _dispatch_one(self, batch: list[SensorFrameEvent]) -> None:
        ctx = BatchContext(
            batch_id=self._id_factory(),
            batch_size=len(batch),
            started_at_monotonic=self._clock(),
        )
        start = self._clock()
        try:
            await self._dispatch(batch, ctx)
        except Exception:  # noqa: BLE001 — keep the loop alive on bad batches
            self._logger.exception(
                "batch dispatch raised; dropping batch_id=%s size=%d",
                ctx.batch_id,
                len(batch),
            )
            return
        finally:
            self.counters.batches_dispatched += 1
            self.counters.frames_batched += len(batch)
            if len(batch) >= self._batch_size:
                self.counters.full_batches += 1
            else:
                self.counters.timeout_flushes += 1
            self.counters.last_latency_ms = (self._clock() - start) * 1000.0
