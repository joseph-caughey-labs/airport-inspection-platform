"""GPU-unavailable fallback simulation.

Models the choice between "GPU path" (fast, default) and
"CPU fallback path" (slower, used when GPU is reported unavailable).
This is a simulation — the platform demo doesn't ship CUDA. The point
is to exercise the orchestration around mode switching so an operator
sees the latency increase in real time and the runbook for the
"AI GPU unavailable" failure mode (drafted by SRE for T-509) can
reference real behavior.

Behavior:

  - `RuntimeMode.gpu`: default. `simulate_latency_ms = 5` (a typical
    GPU per-frame inference cost on small heads).
  - `RuntimeMode.cpu_fallback`: triggered manually via the admin
    endpoint OR automatically when an "unhealthy GPU" signal arrives
    (T-503 wires the auto path; this PR ships the manual surface).
    `simulate_latency_ms = 50`.

Every detection emitted while a mode is active records
`metadata.mode = "gpu" | "cpu_fallback"` and
`metadata.mode_latency_ms = <int>`. The mode is read once at
detection-emit time inside the runtime, NOT at consumer time — so a
mid-batch flip cleanly affects subsequent emissions without losing
the in-flight ones.

Transition logging surfaces the *reason* string so a postmortem can
reconstruct who/what triggered the switch.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Literal

ModeName = Literal["gpu", "cpu_fallback"]

DEFAULT_GPU_LATENCY_MS = 5
DEFAULT_CPU_FALLBACK_LATENCY_MS = 50


@dataclass(frozen=True)
class ModeProfile:
    name: ModeName
    simulate_latency_ms: int
    description: str


GPU_PROFILE = ModeProfile(
    name="gpu",
    simulate_latency_ms=DEFAULT_GPU_LATENCY_MS,
    description="GPU inference path (default).",
)
CPU_FALLBACK_PROFILE = ModeProfile(
    name="cpu_fallback",
    simulate_latency_ms=DEFAULT_CPU_FALLBACK_LATENCY_MS,
    description="CPU fallback — GPU reported unavailable.",
)


class RuntimeModeController:
    """Holds the current mode + the reason for the last transition.

    Thread-safety: writes go through an asyncio.Lock so a concurrent
    `set_mode()` call from the HTTP layer can't race against the
    runtime reading the current mode in the middle of a batch.
    """

    def __init__(
        self,
        *,
        initial_mode: ModeName = "gpu",
        gpu_latency_ms: int = DEFAULT_GPU_LATENCY_MS,
        cpu_fallback_latency_ms: int = DEFAULT_CPU_FALLBACK_LATENCY_MS,
        simulate_latency: bool = False,
        logger: logging.Logger | None = None,
    ) -> None:
        if gpu_latency_ms < 0 or cpu_fallback_latency_ms < 0:
            raise ValueError("latency_ms must be ≥ 0")
        if cpu_fallback_latency_ms < gpu_latency_ms:
            raise ValueError("cpu_fallback_latency_ms must be ≥ gpu_latency_ms")
        self._profiles: dict[ModeName, ModeProfile] = {
            "gpu": ModeProfile(
                name="gpu",
                simulate_latency_ms=gpu_latency_ms,
                description=GPU_PROFILE.description,
            ),
            "cpu_fallback": ModeProfile(
                name="cpu_fallback",
                simulate_latency_ms=cpu_fallback_latency_ms,
                description=CPU_FALLBACK_PROFILE.description,
            ),
        }
        if initial_mode not in self._profiles:
            raise ValueError(f"unknown initial_mode: {initial_mode!r}")
        self._current: ModeName = initial_mode
        self._last_reason: str = "initial"
        self._last_transition_at_monotonic: float = time.monotonic()
        self._simulate_latency = simulate_latency
        self._logger = logger or logging.getLogger("ai-inference.runtime-mode")
        self._lock = asyncio.Lock()

    @property
    def current(self) -> ModeName:
        return self._current

    @property
    def last_reason(self) -> str:
        return self._last_reason

    @property
    def profile(self) -> ModeProfile:
        return self._profiles[self._current]

    def snapshot(self) -> dict[str, object]:
        """Read-only view safe to return from the admin HTTP route."""
        return {
            "mode": self._current,
            "latency_ms": self.profile.simulate_latency_ms,
            "last_reason": self._last_reason,
            "since_seconds": round(time.monotonic() - self._last_transition_at_monotonic, 3),
        }

    async def set_mode(self, mode: ModeName, reason: str) -> bool:
        """Switches to `mode`. Returns True if the mode actually
        changed, False if it was already at `mode` (the reason is
        still logged so audit trails keep a record)."""
        if mode not in self._profiles:
            raise ValueError(f"unknown mode: {mode!r}")
        async with self._lock:
            previous = self._current
            self._last_reason = reason
            if previous == mode:
                self._logger.info("runtime-mode no-op set_mode mode=%s reason=%s", mode, reason)
                return False
            self._current = mode
            self._last_transition_at_monotonic = time.monotonic()
        self._logger.warning(
            "runtime-mode transition previous=%s next=%s reason=%s "
            "(simulated_latency_ms %d → %d)",
            previous,
            mode,
            reason,
            self._profiles[previous].simulate_latency_ms,
            self._profiles[mode].simulate_latency_ms,
        )
        return True

    async def apply_latency(self) -> None:
        """If `simulate_latency=True`, sleeps for the current mode's
        latency. Off by default so tests don't pay 50ms per emission.
        Real load tests (T-513) flip it on to drive realistic
        end-to-end timing."""
        if not self._simulate_latency:
            return
        latency_s = self.profile.simulate_latency_ms / 1000.0
        if latency_s > 0:
            await asyncio.sleep(latency_s)
