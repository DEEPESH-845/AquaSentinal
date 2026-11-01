"""Cheap image-quality metrics with OpenCV, computed on every captured frame.

These are image statistics, not a turbidity measurement. The visibility estimate combines RMS contrast and Laplacian
sharpness, normalised with constants fitted to frames of the digital twin (docs/PERCEPTION_PIPELINE.md, calibration).
"""

from __future__ import annotations

import cv2
import numpy as np

from ..geometry import perception_defaults
from ..schemas import ImageQuality

# Fitted on 2026-11-01 to 20 twin captures (640 x 480 JPEG, headless Chromium with SwiftShader GL): gantry at (50, 20) and
# (75, 25), turbidity 0 to 1 at lighting 0.8, plus lighting 0.2 and 0.5 at turbidity 0.15. The target was the twin's simulated
# visibility; the fit maximised agreement of the shared/perception.json bands (20 of 20) and then minimised RMS error (0.040,
# worst 0.083). Contrast tracks turbidity monotonically on twin frames. Sharpness does not: Laplacian variance rises again in
# murk, where it is mostly quantisation noise, so it only carries a 0.1 weight as a blur guard. Real camera frames are unfitted.
CONTRAST_REF = 0.07
SHARPNESS_REF = 500.0
CONTRAST_WEIGHT = 0.9


def decode(jpeg: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("frame is not a decodable image")
    return img


def analyze(img: np.ndarray) -> ImageQuality:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    brightness = float(cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 2].mean() / 255)
    contrast = float(gray.std() / 255)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    b, _, r = (float(c) for c in cv2.mean(img)[:3])
    red_blue = r / (b + 1e-6)
    visibility = CONTRAST_WEIGHT * min(1.0, contrast / CONTRAST_REF) + (1 - CONTRAST_WEIGHT) * min(1.0, sharpness / SHARPNESS_REF)
    if brightness < 0.06:  # a black frame has no usable contrast whatever the statistics say
        visibility = min(visibility, 0.05)
    p = perception_defaults()
    band = "GOOD" if visibility >= p["degradedVisibility"] else "DEGRADED" if visibility >= p["unsafeVisibility"] else "UNRELIABLE"
    return ImageQuality(
        brightness=round(brightness, 4),
        contrast=round(contrast, 4),
        sharpness=round(sharpness, 2),
        red_blue_ratio=round(red_blue, 3),
        visibility_estimate=round(visibility, 4),
        band=band,
    )


def fingerprint(img: np.ndarray) -> np.ndarray:
    """16 x 12 grey thumbnail for near-duplicate detection."""
    return cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (16, 12), interpolation=cv2.INTER_AREA).astype(np.float32)


def is_duplicate(a: np.ndarray, b: np.ndarray, threshold: float = 1.5) -> bool:
    return float(np.abs(a - b).mean()) < threshold
