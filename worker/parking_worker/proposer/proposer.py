"""The layout proposer (HDD §4.6): stall outlines from painted lines and parked cars.

Pipeline, all on one photo: paint mask -> divider direction (LSD) -> rotate into the divider
frame -> stall bands split at row lines -> divider peaks per band -> lot pitch -> evenly spaced
stalls per row (missing dividers filled, rows extended over parked cars) -> rows of cars with
no paint -> outlines back on the photo.

Evidence per stall (0..1), so admins can review the least certain first:

    evidence = min(1, 0.1 + 0.35 * L + 0.35 * R + 0.3 * C)

L and R are the painted share of the stall's left and right divider, scaled so 50% of the
row depth counts as fully seen (``min(1, share / 0.5)``; 0 for a divider filled in from the
lattice); C is 1 when a detected car is centred in the stall. So two clear dividers give
0.8, a car-only stall 0.4, and a pure lattice fill 0.1.
"""

from __future__ import annotations

from collections.abc import Sequence

import cv2
import numpy as np
from parking_core.models import ProposedStall, Rect

from ..scorers.acpds_yolo import CarDetector, Detection, decode_photo
from . import rows as R
from .cars import Car, car_boxes, to_frame
from .frame import Frame, make_frame
from .lines import divider_angle, paint_mask, segments, stroke_width

ALGO_VERSION = "proposer-1"
COORD_DIGITS = 4
"""Outline corners are stored to 4 decimals (0.2 px on a 2000 px photo), like drawn outlines,
which keeps a run of many hundreds of stalls well inside a DynamoDB item."""
WORK_SIDE = 2000
"""Photos with a longer side are downscaled to it first: a drone frame is 4000-8000 px wide,
and stall lines stay several pixels wide at 2000 px."""
MIN_IN_FRAME = 0.9
"""A stall is proposed only if this share of it is on the photo, like the hand-drawn layouts
(a stall cut off by the frame cannot be scored reliably)."""
EVIDENCE_FLOOR = 0.1
EVIDENCE_DIVIDER = 0.35
EVIDENCE_CAR = 0.3
DIVIDER_SEEN = 0.5
"""Painted share of the row depth at which a divider counts as fully seen."""
CAR_CENTRED = 0.3
"""A car is in a stall when its centre is within this share of the stall width of the
stall's centre line (and between the stall's ends)."""


class LayoutProposerImpl:
    """`LayoutProposer` over numpy + OpenCV, with an optional car detector (YOLO)."""

    def __init__(self, car_detector: CarDetector | None = None) -> None:
        self.car_detector = car_detector
        self.model_version = f"{ALGO_VERSION}|lines" + ("+cars" if car_detector else "")

    def propose(self, image: bytes) -> list[ProposedStall]:
        bgr = decode_photo(image)
        detections = self.car_detector(bgr) if self.car_detector is not None else []
        return propose_stalls(bgr, detections)


def evidence(stall: R.FrameStall) -> float:
    left = min(1.0, stall.left / DIVIDER_SEEN)
    right = min(1.0, stall.right / DIVIDER_SEEN)
    value = EVIDENCE_FLOOR + EVIDENCE_DIVIDER * (left + right) + EVIDENCE_CAR * stall.car
    return float(min(1.0, value))


def _mark_cars(stalls: Sequence[R.FrameStall], cars: Sequence[Car]) -> None:
    for s in stalls:
        xc, half = (s.x0 + s.x1) / 2, CAR_CENTRED * (s.x1 - s.x0)
        s.car = s.car or any(abs(c.cx - xc) <= half and s.y0 <= c.cy <= s.y1 for c in cars)


def _in_frame_share(poly: np.ndarray, width: int, height: int) -> float:
    area = cv2.contourArea(poly.astype(np.float32))
    if area <= 0:
        return 0.0
    rect = np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float32)
    inter, _ = cv2.intersectConvexConvex(poly.astype(np.float32), rect)
    return float(inter) / area


def _fit_depths(frame: Frame, bands: list[R.Band], vert: np.ndarray, stroke: float) -> float:
    """Typical row depth from rows seen whole; rows running off the photo get that depth
    (extended past the photo edge, where the in-frame check judges their stalls)."""
    cut: list[tuple[bool, bool]] = []
    for band in bands:
        xs = [x for x, _ in R.column_peaks(vert, band, stroke)]
        top = band.top_open and R.off_photo(frame, xs, band.y0 - 3 * stroke)
        bottom = band.bottom_open and R.off_photo(frame, xs, band.y1 + 3 * stroke)
        cut.append((top, bottom))
    whole = [b.depth for b, c in zip(bands, cut, strict=True) if not any(c)]
    depth = float(np.median(whole or [b.depth for b in bands]))
    for band, (top, bottom) in zip(bands, cut, strict=True):
        if band.depth < depth:
            if top:
                band.y0 = band.y1 - depth
            elif bottom:
                band.y1 = band.y0 + depth
    return depth


def find_rows(bgr: np.ndarray, boxes: np.ndarray) -> tuple[Frame, list[list[R.FrameStall]]]:
    """Stall rows in the divider frame, from the paint and the car boxes (photo px)."""
    height, width = bgr.shape[:2]
    side = max(height, width)
    mask = paint_mask(bgr)
    stroke = stroke_width(mask)
    angle = divider_angle(segments(mask), stroke, side)
    if angle is None and len(boxes):
        # No paint: cars park along the stall's depth, so dividers run along the boxes' long side.
        tall = np.median(boxes[:, 3] - boxes[:, 1]) >= np.median(boxes[:, 2] - boxes[:, 0])
        angle = 90.0 if tall else 0.0
    frame = make_frame(angle, width, height)
    cars = to_frame(boxes, frame)
    vert, horiz = R.stroke_masks(frame.warp(mask), stroke, side)
    vert = R.mask_cars(vert, cars, stroke)
    bands = R.find_bands(vert, horiz, stroke, side)
    pitch = depth = None
    if bands:
        bands = R.split_tall(bands, depth=float(np.median([b.depth for b in bands])))
        peaks = [R.column_peaks(vert, b, stroke) for b in bands]
        pitch = R.estimate_pitch(peaks, float(np.median([b.depth for b in bands])))
        if pitch:
            bands = R.split_tall(bands, pitch=pitch)
        depth = _fit_depths(frame, bands, vert, stroke)
    rows: list[list[R.FrameStall]] = []
    if pitch:
        for band in bands:
            peaks = R.column_peaks(vert, band, stroke)
            stalls = R.row_stalls(R.select_dividers(peaks, pitch), pitch, band, cars)
            if stalls:
                rows.append(stalls)
    placed = [s for row in rows for s in row]
    _mark_cars(placed, cars)
    loose = [
        c for c in cars if not any(s.x0 <= c.cx <= s.x1 and s.y0 <= c.cy <= s.y1 for s in placed)
    ]
    rows.extend(R.car_rows(loose, pitch, depth))
    return frame, rows


def propose_stalls(bgr: np.ndarray, detections: Sequence[Detection]) -> list[ProposedStall]:
    """Proposed stalls for a decoded BGR photo, sorted by row then column."""
    height, width = bgr.shape[:2]
    scale = min(1.0, WORK_SIDE / max(height, width))
    work = bgr
    if scale < 1.0:
        size = (max(2, round(width * scale)), max(2, round(height * scale)))
        work = cv2.resize(bgr, size, interpolation=cv2.INTER_AREA)
    wh, ww = work.shape[:2]
    boxes = car_boxes(detections, width, height) * scale
    frame, rows = find_rows(work, boxes)

    kept: list[tuple[float, list[tuple[R.FrameStall, np.ndarray]]]] = []
    for row in rows:
        good = []
        for s in sorted(row, key=lambda s: s.x0):
            corners = np.array([[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]])
            poly = frame.to_photo(corners)
            if _in_frame_share(poly, ww, wh) >= MIN_IN_FRAME:
                good.append((s, poly))
        if good:
            kept.append((float(np.mean([(s.y0 + s.y1) / 2 for s, _ in good])), good))
    kept.sort(key=lambda r: r[0])
    if not kept:
        return []
    min_x = min(s.x0 for _, row in kept for s, _ in row)
    min_y = min(s.y0 for _, row in kept for s, _ in row)
    out = []
    for r, (_, row) in enumerate(kept):
        for c, (s, poly) in enumerate(row):
            frac = np.clip(poly / [ww, wh], 0.0, 1.0)
            out.append(
                ProposedStall(
                    polygon=[
                        (round(float(x), COORD_DIGITS), round(float(y), COORD_DIGITS))
                        for x, y in frac
                    ],
                    evidence=round(evidence(s), 3),
                    row=r,
                    col=c,
                    map_rect=Rect(
                        x=round((s.x0 - min_x) / ww, 5),
                        y=round((s.y0 - min_y) / ww, 5),
                        w=round((s.x1 - s.x0) / ww, 5),
                        h=round((s.y1 - s.y0) / ww, 5),
                    ),
                )
            )
    return out
