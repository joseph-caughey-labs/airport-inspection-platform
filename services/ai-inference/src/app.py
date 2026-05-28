"""FastAPI app for the ai-inference service.

Wires the AiRuntime into the lifespan so the Redis consumer is alive
for the lifetime of the HTTP server. The HTTP surface (/health, /ready,
/metrics) is the same as the Phase 1 shell — `/ready` keeps probing
Redis so the orchestration layer reports unhealthy if the broker drops.

Detector registry is intentionally empty at T-301. Each T-302..T-305
ticket registers its detector in this `build_app` call.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, generate_latest
from prometheus_client.metrics_core import GaugeMetricFamily

from .detectors import DetectorRegistry
from .pipeline import AiRuntime, RuntimeConfig
from .redis_client import check_health, create_redis


def build_app(
    redis_client: Any | None = None,
    detector_registry: DetectorRegistry | None = None,
    config: RuntimeConfig | None = None,
) -> FastAPI:
    client = redis_client if redis_client is not None else create_redis()
    registry = detector_registry if detector_registry is not None else DetectorRegistry()
    cfg = config if config is not None else RuntimeConfig.from_env()
    runtime = AiRuntime(redis=client, registry=registry, config=cfg)
    logger = logging.getLogger("ai-inference.app")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):  # type: ignore[no-untyped-def]
        try:
            await runtime.start()
            yield
        finally:
            await runtime.stop()

    app = FastAPI(title="ai-inference", version="0.2.0", lifespan=lifespan)
    app.state.runtime = runtime
    metrics_registry = CollectorRegistry()

    # Service-tag metric so any /metrics scrape includes a service label.
    class _ServiceLabel:
        @staticmethod
        def collect() -> list[GaugeMetricFamily]:
            g = GaugeMetricFamily(
                "service_info",
                "Static service identification.",
                labels=["service", "version"],
            )
            g.add_metric(["ai-inference", os.environ.get("APP_VERSION", "0.2.0")], 1)
            return [g]

    metrics_registry.register(_ServiceLabel())  # type: ignore[arg-type]

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/ready")
    async def ready() -> Response:
        result = await check_health(client)
        if not result.healthy:
            return JSONResponse(
                status_code=503,
                content={
                    "status": "unhealthy",
                    "latency_ms": result.latency_ms,
                    **({"error": result.error} if result.error else {}),
                },
            )
        return JSONResponse(content={"status": "ready", "latency_ms": result.latency_ms})

    @app.get("/metrics")
    async def metrics() -> Response:
        return Response(
            content=generate_latest(metrics_registry),
            media_type=CONTENT_TYPE_LATEST,
        )

    logger.debug("build_app complete: detectors=%s", registry.names())
    return app


app = build_app()
