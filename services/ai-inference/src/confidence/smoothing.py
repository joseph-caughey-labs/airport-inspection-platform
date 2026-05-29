"""Temporal smoothing — multi-frame consensus to suppress single-frame
false positives.

A detector that flickers on for one frame and off on the next is
almost always noise — a leaf blowing across the runway, a glare
spike, etc. The smoother holds a sliding window per
`(sensor_id, detection_class)` and requires the class to fire on
`threshold` out of the last `window_size` frames before allowing the
detection to flow to the publisher.

Defaults (`window_size=5`, `threshold=3`) match the T-309 AC:
    - Single-frame fires → suppressed.
    - Sustained 3+ frames → emit.

The smoother sits BETWEEN the calibrator and the publisher. By that
point each detection has already passed `min_publish_threshold`, so
we're not gating on low-confidence noise — we're gating on
inconsistent confidence across time.

Detections from classes NOT in `classes_to_smooth` pass through
unchanged. The default is `("fod",)` — FOD is the classic noisy
class. Crack, snowbank, and wildlife are typically slower to
develop so temporal smoothing isn't useful (and anomaly's whole
point is to flag uncertain single-frame events for HITL review).
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Final

from ..models import DetectionPayload

DEFAULT_WINDOW_SIZE: Final[int] = 5
DEFAULT_THRESHOLD: Final[int] = 3
DEFAULT_SMOOTHED_CLASSES: Final[tuple[str, ...]] = ("fod",)


@dataclass
class SmoothingCounters:
    detections_emitted: int = 0
    detections_suppressed: int = 0


@dataclass
class TemporalSmoother:
    """Per-key sliding window with `threshold of window_size` agreement.

    State is keyed by `(sensor_id, detection_class)` and is a deque
    of bools sized to `window_size`. Every observe call slides the
    deque by one for every smoothed class, so a class that stops
    firing has its window decay to all-False over `window_size`
    observations.
    """

    window_size: int = DEFAULT_WINDOW_SIZE
    threshold: int = DEFAULT_THRESHOLD
    classes_to_smooth: tuple[str, ...] = DEFAULT_SMOOTHED_CLASSES
    counters: SmoothingCounters = field(default_factory=SmoothingCounters)
    _state: dict[tuple[str, str], deque[bool]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.window_size < 1:
            raise ValueError("window_size must be ≥ 1")
        if self.threshold < 1:
            raise ValueError("threshold must be ≥ 1")
        if self.threshold > self.window_size:
            raise ValueError("threshold cannot exceed window_size")

    def _smoothed(self) -> frozenset[str]:
        return frozenset(self.classes_to_smooth)

    def observe(
        self,
        sensor_id: str,
        detections: Iterable[DetectionPayload],
    ) -> list[DetectionPayload]:
        """Records this frame's detection set for `sensor_id` and
        returns the subset that should reach the publisher."""
        detections_list = list(detections)
        smoothed_classes = self._smoothed()

        # Classes that fired this frame, keyed by class → detection.
        # If a detector somehow emits two detections of the same class
        # (it shouldn't today), we keep the first one.
        emitted_per_class: dict[str, DetectionPayload] = {}
        for d in detections_list:
            emitted_per_class.setdefault(d.detection_class, d)

        # Pass-through for classes we don't smooth.
        output: list[DetectionPayload] = [
            d for d in detections_list if d.detection_class not in smoothed_classes
        ]

        for cls in smoothed_classes:
            key = (sensor_id, cls)
            window = self._state.get(key)
            if window is None:
                window = deque(maxlen=self.window_size)
                self._state[key] = window
            fired = cls in emitted_per_class
            window.append(fired)
            count = sum(1 for v in window if v)
            if fired and count >= self.threshold:
                detection = emitted_per_class[cls]
                meta = dict(detection.metadata)
                meta["smoothing"] = {
                    "window_count": count,
                    "window_size": self.window_size,
                    "threshold": self.threshold,
                }
                output.append(detection.model_copy(update={"metadata": meta}))
                self.counters.detections_emitted += 1
            elif fired:
                # Fired but below threshold → suppress.
                self.counters.detections_suppressed += 1
            # If not fired, window updates only; no emission to count.

        return output

    def reset(self, sensor_id: str | None = None) -> None:
        """Drops smoothing state. Useful between test cases or when
        the runtime wants to clear stale state for a sensor whose
        stream went dormant (T-510 SRE runbook scenario)."""
        if sensor_id is None:
            self._state.clear()
            return
        for key in list(self._state):
            if key[0] == sensor_id:
                del self._state[key]
