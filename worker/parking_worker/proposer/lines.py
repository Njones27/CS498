"""Painted stall lines: the paint mask, its stroke width, and the divider direction.

Everything here is numpy + OpenCV so the proposer runs without torch.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

TOPHAT_FRAC = 0.02
"""White top-hat kernel as a share of the photo's long side: wider than any painted line,
narrower than the asphalt's slow brightness changes (shade, stains), so paint stands out."""
MIN_CONTRAST = 20
"""Paint must be at least this much brighter (0..255) than the asphalt around it."""
CONTRAST_SHARE = 0.3
"""Paint threshold as a share of the brightest 0.5% of the top-hat: adapts to exposure."""
SEGMENT_FRAC = 0.02
"""Line segments shorter than this share of the long side are ignored for the angle."""
ANGLE_TOL_DEG = 4.0
"""A segment belongs to a line family when its direction is within this of the family's."""


def _odd(n: float) -> int:
    k = max(3, round(n))
    return k if k % 2 else k + 1


def paint_mask(bgr: np.ndarray) -> np.ndarray:
    """uint8 0/1 mask of painted lines: bright against the local asphalt, and white or yellow.

    The brightness threshold is relative (top-hat against a local opening, cut at a share of
    the brightest paint), so a dull overcast photo and a sunny one both work.
    """
    side = max(bgr.shape[:2])
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    k = _odd(TOPHAT_FRAC * side)
    tophat = cv2.morphologyEx(
        val, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    )
    level = float(np.percentile(tophat[::3, ::3], 99.5))
    if level < MIN_CONTRAST:
        return np.zeros(bgr.shape[:2], dtype=np.uint8)
    bright = tophat > max(MIN_CONTRAST, CONTRAST_SHARE * level)
    white = sat < max(50.0, float(np.median(sat[::3, ::3])) + 30.0)
    yellow = (hue >= 15) & (hue <= 40) & (sat >= 60)
    return (bright & (white | yellow)).astype(np.uint8)


def stroke_width(mask: np.ndarray) -> float:
    """Typical painted line width in px: twice the distance-transform value along stroke ridges.

    Lines outnumber other bright shapes along their centrelines, so the median is a line's.
    """
    if not mask.any():
        return 3.0
    dt = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    ridge = (dt > 0) & (dt >= cv2.dilate(dt, np.ones((3, 3), np.uint8)))
    values = dt[ridge]
    return float(max(2.0, 2.0 * np.median(values))) if values.size else 3.0


def segments(mask: np.ndarray) -> np.ndarray:
    """LSD line segments ``[N, 4]`` (x1, y1, x2, y2) on the paint mask, short ones dropped."""
    if not mask.any():
        return np.zeros((0, 4), dtype=np.float32)
    lsd = cv2.createLineSegmentDetector()
    found = lsd.detect(mask * 255)[0]
    if found is None:
        return np.zeros((0, 4), dtype=np.float32)
    segs = found.reshape(-1, 4)
    length = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    return segs[length >= SEGMENT_FRAC * max(mask.shape)]


def _angle_diff(a: np.ndarray, b: float) -> np.ndarray:
    """Smallest difference between directions (degrees, period 180)."""
    return np.abs((a - b + 90.0) % 180.0 - 90.0)


def _distinct_offsets(segs: np.ndarray, phi: float, gap: float, min_len: float) -> int:
    """How many separate parallel lines a family forms (offsets across its direction).

    Stall dividers are many short lines side by side; row lines and dashed aisle lines are a
    few lines broken into collinear pieces. So the family with more distinct offsets is the
    dividers.
    """
    if len(segs) == 0:
        return 0
    rad = math.radians(phi)
    normal = np.array([-math.sin(rad), math.cos(rad)])
    mid = (segs[:, :2] + segs[:, 2:]) / 2.0
    offsets = mid @ normal
    length = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    order = np.argsort(offsets)
    offsets, length = offsets[order], length[order]
    count, total = 0, length[0]
    for i in range(1, len(offsets)):
        if offsets[i] - offsets[i - 1] > gap:
            count += total >= min_len
            total = 0.0
        total += length[i]
    return count + (total >= min_len)


def divider_angle(segs: np.ndarray, stroke: float, side: int) -> float | None:
    """Direction of the stall dividers in photo degrees, [0, 180) (90 = vertical), or None.

    A length-weighted histogram of segment directions folded to 90 degrees finds the lot's
    grid; the two perpendicular families are dividers and row lines, told apart by
    `_distinct_offsets`. The result is the length-weighted mean of the chosen family.
    """
    if len(segs) == 0:
        return None
    dx = segs[:, 2] - segs[:, 0]
    dy = segs[:, 3] - segs[:, 1]
    angle = np.degrees(np.arctan2(dy, dx)) % 180.0
    length = np.hypot(dx, dy)
    hist, _ = np.histogram(angle % 90.0, bins=180, range=(0.0, 90.0), weights=length)
    kernel = np.array([1.0, 2.0, 3.0, 2.0, 1.0])
    smooth = np.convolve(np.concatenate([hist[-2:], hist, hist[:2]]), kernel, mode="valid")
    peak = (float(np.argmax(smooth)) + 0.5) * 0.5
    min_len = SEGMENT_FRAC * side * 2
    best: tuple[int, float, float] | None = None
    for phi in (peak, peak + 90.0):
        member = _angle_diff(angle, phi) <= ANGLE_TOL_DEG
        if not member.any():
            continue
        fam = segs[member]
        # Length-weighted mean direction, unwrapped around phi.
        delta = (angle[member] - phi + 90.0) % 180.0 - 90.0
        refined = (phi + float(np.average(delta, weights=length[member]))) % 180.0
        key = (
            _distinct_offsets(fam, refined, 2.0 * stroke + 2.0, min_len),
            float(length[member].sum()),
        )
        if best is None or key > best[:2]:
            best = (key[0], key[1], refined)
    return None if best is None else best[2]
