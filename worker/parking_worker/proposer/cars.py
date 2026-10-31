"""Parked cars as layout evidence: which detections are cars, and where they sit in the frame.

YOLO trained on street photos often names a car seen from straight above something else
("cell phone" on the drone test photo), so the class is ignored: a detection counts as a car
when its size matches the typical car's. That size comes from the detections YOLO did call a
car, truck or bus when there are a few, else from all detections.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from ..scorers.acpds_yolo import CAR_CLASSES, Detection
from .frame import Frame

DEDUPE_IOU = 0.6
"""Boxes overlapping more than this are one object reported under two classes."""
SIZE_RANGE = (0.6, 1.6)
"""A car's long and short box sides must be within this factor of the median detection's."""
BORDER_PX = 2.0
MIN_NAMED_CARS = 3
"""Detections named car/truck/bus needed to take the car size from them alone."""


@dataclass(frozen=True)
class Car:
    """A car in the divider frame: centre, width along the row (``a``), length across (``b``)."""

    cx: float
    cy: float
    a: float
    b: float


def _iou(p: np.ndarray, q: np.ndarray) -> float:
    ix = max(0.0, min(p[2], q[2]) - max(p[0], q[0]))
    iy = max(0.0, min(p[3], q[3]) - max(p[1], q[1]))
    inter = ix * iy
    union = (p[2] - p[0]) * (p[3] - p[1]) + (q[2] - q[0]) * (q[3] - q[1]) - inter
    return inter / union if union > 0 else 0.0


def car_boxes(detections: Sequence[Detection], width: int, height: int) -> np.ndarray:
    """``[N, 4]`` xyxy boxes that look like cars: deduplicated, then sized like the median.

    A box cut off by the photo edge only has to match on its short side (its long side may
    be truncated) and must not be longer than a car.
    """
    dets = sorted(detections, key=lambda d: -d.conf)
    kept: list[np.ndarray] = []
    named: list[bool] = []
    for det in dets:
        box = np.asarray(det.box_xyxy, dtype=np.float64)
        if box[2] - box[0] < 2 or box[3] - box[1] < 2:
            continue
        if all(_iou(box, k) <= DEDUPE_IOU for k in kept):
            kept.append(box)
            named.append(det.cls_name in CAR_CLASSES)
    if not kept:
        return np.zeros((0, 4))
    boxes = np.array(kept)
    is_car = np.array(named)
    w = boxes[:, 2] - boxes[:, 0]
    h = boxes[:, 3] - boxes[:, 1]
    long, short = np.maximum(w, h), np.minimum(w, h)
    border = (
        (boxes[:, 0] <= BORDER_PX)
        | (boxes[:, 1] <= BORDER_PX)
        | (boxes[:, 2] >= width - BORDER_PX)
        | (boxes[:, 3] >= height - BORDER_PX)
    )
    ref = ~border if (~border).any() else np.ones(len(boxes), bool)
    if (ref & is_car).sum() >= MIN_NAMED_CARS:
        ref = ref & is_car  # people, signs or poles must not set the car size
    med_long, med_short = float(np.median(long[ref])), float(np.median(short[ref]))
    lo, hi = SIZE_RANGE
    short_ok = (short >= lo * med_short) & (short <= hi * med_short)
    long_ok = (long >= lo * med_long) & (long <= hi * med_long)
    keep = short_ok & (long_ok | (border & (long <= hi * med_long)))
    return boxes[keep]


def to_frame(boxes: np.ndarray, frame: Frame) -> list[Car]:
    """Cars in the frame. An axis-aligned photo box of a car turned by the frame's rotation is
    larger than the car, so the car's own sides are solved from the box (near 45 degrees, where
    that is ill-conditioned, a box side is used)."""
    if len(boxes) == 0:
        return []
    rad = np.radians(frame.rotation_deg)
    c, s = abs(float(np.cos(rad))), abs(float(np.sin(rad)))
    det = c * c - s * s
    centres = frame.to_frame((boxes[:, :2] + boxes[:, 2:]) / 2.0)
    cars = []
    for box, (cx, cy) in zip(boxes, centres, strict=True):
        bw, bh = box[2] - box[0], box[3] - box[1]
        floor = 0.3 * min(bw, bh)
        if abs(det) > 0.35:
            a = max(floor, (c * bw - s * bh) / det)
            b = max(floor, (c * bh - s * bw) / det)
        else:
            a = b = 0.6 * min(bw, bh)
        cars.append(Car(float(cx), float(cy), float(a), float(b)))
    return cars
