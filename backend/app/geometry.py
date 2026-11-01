"""Camera and gantry geometry, read from shared/geometry.json: the same file lib/sim/constants.ts imports.

Pixel <-> gantry conversion here must match lib/sim/detection.ts (feed right = +world X = +gantry x,
feed down = +world Z = +gantry y). tests/test_geometry.py pins it against values computed by the TypeScript engine.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache

from .config import SHARED_DIR


@lru_cache(maxsize=1)
def _geo() -> dict:
    return json.loads((SHARED_DIR / "geometry.json").read_text())


@lru_cache(maxsize=1)
def perception_defaults() -> dict:
    return json.loads((SHARED_DIR / "perception.json").read_text())


def travel() -> tuple[float, float]:
    g = _geo()["gantry"]
    return float(g["travelXCm"]), float(g["travelYCm"])


def motion_limits() -> tuple[float, float]:
    g = _geo()["gantry"]
    return float(g["maxSpeedCmS"]), float(g["accelCmS2"])


def capture_size() -> tuple[int, int]:
    c = _geo()["camera"]
    return int(c["captureWidthPx"]), int(c["captureHeightPx"])


def _tans() -> tuple[float, float, float]:
    c = _geo()["camera"]
    tan_h = math.tan(math.radians(c["hfovDeg"]) / 2)
    return tan_h, tan_h / c["aspect"], float(c["lensHeightM"])


def pixel_to_gantry(px: float, py: float, width: int, height: int, gantry_x: float, gantry_y: float) -> tuple[float, float]:
    """Back-project a feed pixel onto the sand plane (world Y = 0) as gantry cm, like detection.ts estX/estY."""
    tan_h, tan_v, lens = _tans()
    u = px / width
    v = py / height
    dx_m = (u * 2 - 1) * lens * tan_h
    dz_m = (v * 2 - 1) * lens * tan_v
    return gantry_x + dx_m * 100, gantry_y + dz_m * 100


def footprint_half_cm() -> tuple[float, float]:
    """Half width and height of the camera footprint on the sand, in cm."""
    tan_h, tan_v, lens = _tans()
    return lens * tan_h * 100, lens * tan_v * 100
