"""Redis client wrapper for ai-inference.

Mirrors the convention in `@aip/redis-client` (Node side): one client
per process, sensible reconnect defaults, sanitized health probe.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

import redis.asyncio as redis_async


def create_redis() -> redis_async.Redis:
    """Build the canonical Redis client for this service."""
    return redis_async.Redis(
        host=os.environ.get("REDIS_HOST", "redis"),
        port=int(os.environ.get("REDIS_PORT", "6379")),
        decode_responses=True,
        socket_connect_timeout=5,
        retry_on_timeout=True,
    )


@dataclass
class HealthResult:
    healthy: bool
    latency_ms: float
    error: str | None = None


async def check_health(client: redis_async.Redis) -> HealthResult:
    """Issue PING and measure round-trip latency. Sanitizes errors."""
    start = time.perf_counter_ns()
    try:
        reply = await client.ping()
        latency_ms = (time.perf_counter_ns() - start) / 1_000_000
        if reply is True or reply == "PONG":
            return HealthResult(healthy=True, latency_ms=latency_ms)
        return HealthResult(
            healthy=False,
            latency_ms=latency_ms,
            error=f"unexpected reply: {reply!r}",
        )
    except Exception as exc:  # noqa: BLE001 — sanitize anything below
        latency_ms = (time.perf_counter_ns() - start) / 1_000_000
        return HealthResult(healthy=False, latency_ms=latency_ms, error=str(exc))
