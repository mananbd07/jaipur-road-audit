"""OpenCV preprocessing tuned for indoor tabletop and roadside capture."""
from __future__ import annotations

from typing import Any

import cv2
import numpy as np


def _letterbox(image: np.ndarray, target_size: tuple[int, int]) -> tuple[np.ndarray, float, tuple[int, int]]:
    """Letterbox an image and return image, resize scale, and (left, top) padding."""
    target_w, target_h = target_size
    height, width = image.shape[:2]
    scale = min(target_w / width, target_h / height)
    resized_w, resized_h = max(1, round(width * scale)), max(1, round(height * scale))
    resized = cv2.resize(image, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR)
    left, top = (target_w - resized_w) // 2, (target_h - resized_h) // 2
    canvas = np.full((target_h, target_w, 3), 114, dtype=np.uint8)
    canvas[top:top + resized_h, left:left + resized_w] = resized
    return canvas, scale, (left, top)


def preprocess_frame(
    frame: np.ndarray,
    target_size: tuple[int, int] = (640, 640),
    roi_bottom_ratio: float = 0.85,
) -> dict[str, Any]:
    """Normalize lighting, denoise, crop the road ROI, and create a YOLO tensor.

    ``processed_frame`` is the bottom road ROI in BGR. Coordinates returned by
    the detector are therefore directly drawable on it. ``letterbox_tensor`` is
    RGB NCHW float32 in the range 0–1 for ONNX Runtime.
    """
    if frame is None or frame.size == 0:
        raise ValueError("preprocess_frame received an empty image")
    if not 0 < roi_bottom_ratio <= 1:
        raise ValueError("roi_bottom_ratio must be in (0, 1]")
    if len(frame.shape) == 2:
        frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
    if frame.shape[2] == 4:
        frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    lighting_score = float(np.mean(gray) / 255.0 * 100.0)

    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    lightness, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
    enhanced = cv2.cvtColor(cv2.merge((clahe.apply(lightness), a_channel, b_channel)), cv2.COLOR_LAB2BGR)
    enhanced = cv2.GaussianBlur(enhanced, (3, 3), 0)

    height = enhanced.shape[0]
    roi_start_y = int(height * (1.0 - roi_bottom_ratio))
    road_roi = enhanced[roi_start_y:].copy()
    letterboxed, scale, pad = _letterbox(road_roi, target_size)
    tensor = cv2.cvtColor(letterboxed, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)
    tensor = np.ascontiguousarray(tensor, dtype=np.float32)[None] / 255.0

    return {
        "processed_frame": road_roi,
        "letterbox_tensor": tensor,
        "scale": float(scale),
        "pad": pad,
        "lighting_score": round(lighting_score, 2),
        "blur_score": round(blur_score, 2),
        "roi_start_y": roi_start_y,
        "roi_bottom_ratio": roi_bottom_ratio,
    }
