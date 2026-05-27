"""FastAPI app for the ai-inference service shell.

Real detectors / pipeline / calibration / fallback all live in their
own packages under `src/`, each populated by a Phase 3 ticket.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, generate_latest
from prometheus_client.metrics_core import GaugeMetricFamily

from .redis_client import check_health, create_redis


def build_app(redis_client: Any | None = None) -> FastAPI:
    app = FastAPI(title="ai-inference", version="0.1.0")
    client = redis_client if redis_client is not None else create_redis()
    registry = CollectorRegistry()

    # Service-tag metric so any /metrics scrape includes a service label.
    class _ServiceLabel:
        @staticmethod
        def collect() -> list[GaugeMetricFamily]:
            g = GaugeMetricFamily(
                "service_info",
                "Static service identification.",
                labels=["service", "version"],
            )
            g.add_metric(["ai-inference", os.environ.get("APP_VERSION", "0.1.0")], 1)
            return [g]

    registry.register(_ServiceLabel())  # type: ignore[arg-type]

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
            content=generate_latest(registry),
            media_type=CONTENT_TYPE_LATEST,
        )

    return app


app = build_app()
