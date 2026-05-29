"""GPU-unavailable fallback simulation."""

from .runtime_mode import (
    CPU_FALLBACK_PROFILE,
    DEFAULT_CPU_FALLBACK_LATENCY_MS,
    DEFAULT_GPU_LATENCY_MS,
    GPU_PROFILE,
    ModeName,
    ModeProfile,
    RuntimeModeController,
)

__all__ = [
    "CPU_FALLBACK_PROFILE",
    "DEFAULT_CPU_FALLBACK_LATENCY_MS",
    "DEFAULT_GPU_LATENCY_MS",
    "GPU_PROFILE",
    "ModeName",
    "ModeProfile",
    "RuntimeModeController",
]
