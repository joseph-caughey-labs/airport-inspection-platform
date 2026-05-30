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
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, generate_latest
from prometheus_client.metrics_core import GaugeMetricFamily
from pydantic import BaseModel, Field

from .confidence import (
    CalibrationConfig,
    Calibrator,
    load_weather_degradation,
)
from .detectors import (
    AnomalyDetector,
    CrackDetector,
    DetectorRegistry,
    FodDetector,
    SnowbankDetector,
    WildlifeDetector,
    load_snowbank_thresholds,
    load_wildlife_thresholds,
)
from .fallback import RuntimeModeController
from .pipeline import AiRuntime, RuntimeConfig
from .redis_client import check_health, create_redis


class _GpuStateRequest(BaseModel):
    mode: str = Field(pattern=r"^(gpu|cpu_fallback)$")
    reason: str = Field(min_length=1, max_length=200)


def _default_calibrator() -> Calibrator:
    """Production calibrator.

    Per-detector linear coefficients are conservative defaults
    derived from the fixture truth set — they intentionally don't
    over-fit. The calibration curve + fitting methodology is
    documented in `docs/validation/risk-scoring.md`. Re-fitting after
    a fixture change happens manually and lands as a coefficient
    change here + a docs revision in the same PR.
    """
    return Calibrator(
        weather=load_weather_degradation(_SOP_BASELINE_PATH),
        per_detector={
            # FOD detector slightly over-confident on borderline truth
            # → narrow the slope so high-score boundary cases settle
            # around 0.7 calibrated.
            "fod": CalibrationConfig(slope=0.95, intercept=0.0, min_publish_threshold=0.4),
            # Crack detector tends to under-shoot — small positive
            # intercept lifts mid-range scores into the 0.6-0.8 band.
            "crack": CalibrationConfig(slope=1.0, intercept=0.05, min_publish_threshold=0.35),
            # Snowbank measurements are deterministic; identity calibration
            # is the right answer.
            "snowbank": CalibrationConfig(slope=1.0, intercept=0.0, min_publish_threshold=0.5),
            # Wildlife: identity. Species set is small enough that
            # the truth-driven score already calibrates well.
            "wildlife": CalibrationConfig(slope=1.0, intercept=0.0, min_publish_threshold=0.4),
            # Anomaly stays at identity — its low-confidence band is
            # already the routing signal for HITL.
            "anomaly": CalibrationConfig(slope=1.0, intercept=0.0, min_publish_threshold=0.0),
        },
    )


# Repo-root-relative path to the SOP baseline. In docker the file is
# copied into the image at build time; locally it's read straight from
# the workspace.
_SOP_BASELINE_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "data"
    / "seed"
    / "reference"
    / "sop-baseline.json"
)


def _default_registry(cfg: RuntimeConfig) -> DetectorRegistry:
    """Production detector registry. Each T-30x ticket adds one head.

    Seeds are offset per detector so two heads constructed from the
    same `cfg.seed` don't draw identical RNG sequences. The offset
    is a stable per-detector constant — same `cfg.seed` reproduces
    the same per-detector seed every run.
    """
    reg = DetectorRegistry()
    reg.register(FodDetector(seed=cfg.seed))
    reg.register(CrackDetector(seed=cfg.seed + 1))
    reg.register(
        SnowbankDetector(
            seed=cfg.seed + 2,
            thresholds=load_snowbank_thresholds(_SOP_BASELINE_PATH),
        )
    )
    high_risk_classes, runway_buffer_m = load_wildlife_thresholds(_SOP_BASELINE_PATH)
    reg.register(
        WildlifeDetector(
            seed=cfg.seed + 3,
            high_risk_classes=high_risk_classes,
            runway_buffer_m=runway_buffer_m,
        )
    )
    reg.register(AnomalyDetector(seed=cfg.seed + 4))
    return reg


def build_app(
    redis_client: Any | None = None,
    detector_registry: DetectorRegistry | None = None,
    config: RuntimeConfig | None = None,
    calibrator: Calibrator | None = None,
    mode_controller: RuntimeModeController | None = None,
) -> FastAPI:
    client = redis_client if redis_client is not None else create_redis()
    cfg = config if config is not None else RuntimeConfig.from_env()
    registry = detector_registry if detector_registry is not None else _default_registry(cfg)
    cal = calibrator if calibrator is not None else _default_calibrator()
    mc = mode_controller if mode_controller is not None else RuntimeModeController()
    runtime = AiRuntime(
        redis=client, registry=registry, config=cfg, calibrator=cal, mode_controller=mc
    )
    logger = logging.getLogger("ai-inference.app")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):  # type: ignore[no-untyped-def]
        try:
            await runtime.start()
            yield
        finally:
            await runtime.stop()

    app = FastAPI(title="ai-inference", version="0.4.0", lifespan=lifespan)
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
            g.add_metric(["ai-inference", os.environ.get("APP_VERSION", "0.4.0")], 1)
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

    # Admin: GPU/CPU-fallback mode control (T-308).
    # Returns the runtime mode controller's snapshot; POST toggles
    # the mode. Production deployments gate this behind the operator
    # role (T-504); the demo runs it unauthenticated for clarity.
    @app.get("/admin/gpu-state")
    async def gpu_state() -> JSONResponse:
        return JSONResponse(content=runtime.mode_controller.snapshot())

    @app.post("/admin/gpu-state")
    async def set_gpu_state(body: _GpuStateRequest) -> JSONResponse:
        try:
            changed = await runtime.mode_controller.set_mode(
                body.mode,  # type: ignore[arg-type]
                body.reason,
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        snapshot = runtime.mode_controller.snapshot()
        snapshot["changed"] = changed
        return JSONResponse(content=snapshot)

    logger.debug("build_app complete: detectors=%s", registry.names())
    return app


app = build_app()
