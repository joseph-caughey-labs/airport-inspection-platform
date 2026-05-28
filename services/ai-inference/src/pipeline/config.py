"""Runtime configuration.

Centralizes the env-derived knobs so tests can build a config object
directly (no env mutation) and the runtime composition only reads
from one place.

Determinism: `seed` propagates into every detector's RNG. T-302+
detectors will be passed this seed at construction. Same seed +
same frame stream → same detection output, every run.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeConfig:
    redis_host: str = "redis"
    redis_port: int = 6379
    frame_channel: str = "sensor.frame.captured"
    max_concurrent: int = 16
    service_name: str = "ai-inference"
    instance_id: str | None = None
    schema_version: str = "v1"
    seed: int = 0
    parallel_detectors: bool = False

    @classmethod
    def from_env(cls) -> RuntimeConfig:
        return cls(
            redis_host=os.environ.get("REDIS_HOST", "redis"),
            redis_port=int(os.environ.get("REDIS_PORT", "6379")),
            frame_channel=os.environ.get("FRAME_CHANNEL", "sensor.frame.captured"),
            max_concurrent=int(os.environ.get("AI_MAX_CONCURRENT", "16")),
            service_name=os.environ.get("AI_SERVICE_NAME", "ai-inference"),
            instance_id=os.environ.get("AI_INSTANCE_ID") or None,
            schema_version=os.environ.get("AI_SCHEMA_VERSION", "v1"),
            seed=int(os.environ.get("AI_SEED", "0")),
            parallel_detectors=(os.environ.get("AI_PARALLEL_DETECTORS", "false") == "true"),
        )
