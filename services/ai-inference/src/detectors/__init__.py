"""Detector heads + the protocol every detector implements.

Each subsequent ticket populates one module under this package:

- T-302: ``fod.py`` — Foreign Object Debris ✅
- T-303: ``crack.py`` — Pavement crack classification ✅
- T-304: ``snowbank.py`` — Snowbank compliance ✅
- T-305: ``wildlife.py`` + ``anomaly.py``.
"""

from .base import Detector, DetectorRegistry
from .crack import CrackDetector
from .fod import FodDetector
from .snowbank import SnowbankDetector, load_snowbank_thresholds

__all__ = [
    "CrackDetector",
    "Detector",
    "DetectorRegistry",
    "FodDetector",
    "SnowbankDetector",
    "load_snowbank_thresholds",
]
