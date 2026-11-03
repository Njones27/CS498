"""Stalls from parked cars, for a photo taken at an angle (HDD §4.6).

From a camera at an angle the paint is foreshortened, partly hidden by cars and trees, and does
not run in the straight, evenly spaced lines the paint proposer looks for (PKLot UFPR04: 13
stalls from paint, none right). The cars it would otherwise only count as evidence show the lot
instead: every car parked there stands in a stall. Each confident car becomes a stall outlined
by its footprint on the photo (the smallest rectangle round its segmentation mask, or its box
without one), flagged `from_car`. The web then straightens them onto the ground plane: rows,
their lean, and the empty stalls between cars (`web/src/mapping/straighten.ts`).
"""

from __future__ import annotations

from collections.abc import Sequence

import cv2
import numpy as np
from parking_core.layouts import is_valid_quad
from parking_core.models import ProposedStall, Rect

from ..scorers.acpds_yolo import CAR_CLASSES, Detection
from .lines import paint_mask, segments

CAR_CONF = 0.3
"""Cars at least this confident stand in a stall."""
MIN_CARS = 6
"""Fewest cars that show a lot (and that the web can straighten)."""
PAINT_EXPLAINS = 0.5
"""The paint layout stands when at least this share of the cars sit in its stalls."""
CAR_EVIDENCE = 0.4
"""A car-only stall's evidence, as for a car-only stall in the paint proposer (see proposer)."""
PAINT_REACH = 0.5
"""Paint within this share of a car's box past its sides counts as that car's stall's paint."""
PAINT_MIN = 0.15
"""Paint pieces shorter than this share of the car's box height are left out (specks, letters)."""
ROW_GAP = 0.6
"""Cars whose bottoms differ by more than this share of a car's height start a new photo row."""
COORD_DIGITS = 4


def _frac(v: float, size: int) -> float:
    return round(float(v) / size, COORD_DIGITS)


def parked_cars(detections: Sequence[Detection]) -> list[Detection]:
    return [d for d in detections if d.cls_name in CAR_CLASSES and d.conf >= CAR_CONF]


def paint_misses_cars(
    stalls: Sequence[ProposedStall], cars: Sequence[Detection], width: int, height: int
) -> bool:
    """Whether the paint layout leaves most parked cars outside its stalls: a photo taken at an
    angle (or a lot with no paint), where the cars show the stalls better than the lines do."""
    if len(cars) < MIN_CARS:
        return False
    polys = [
        (np.array(s.polygon, dtype=np.float32) * [width, height]).astype(np.float32) for s in stalls
    ]
    inside = 0
    for car in cars:
        x0, y0, x1, y1 = car.box_xyxy
        mid = (float((x0 + x1) / 2), float((y0 + y1) / 2))
        if any(cv2.pointPolygonTest(p, mid, False) >= 0 for p in polys):
            inside += 1
    return inside < PAINT_EXPLAINS * len(cars)


def footprint(car: Detection, width: int, height: int) -> np.ndarray | None:
    """The car's outline on the photo as 4 corners (px), clockwise from the top left: the
    smallest rectangle round its mask (so it follows the car's angle), else its box."""
    x0, y0, x1, y1 = car.box_xyxy
    if car.mask is not None and car.mask.any():
        mx, my = car.mask_xy0
        ys, xs = np.nonzero(car.mask)
        pts = np.stack([xs + mx, ys + my], axis=1).astype(np.float32)
        quad = cv2.boxPoints(cv2.minAreaRect(pts)).astype(np.float64)
    else:
        quad = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float64)
    quad[:, 0] = np.clip(quad[:, 0], 0, width)
    quad[:, 1] = np.clip(quad[:, 1], 0, height)
    mid = quad.mean(axis=0)
    quad = quad[np.argsort(np.arctan2(quad[:, 1] - mid[1], quad[:, 0] - mid[0]))]
    start = int(np.argmin(quad.sum(axis=1)))  # the top-left corner first
    quad = np.roll(quad, -start, axis=0)
    if not is_valid_quad([(float(x) / width, float(y) / height) for x, y in quad]):
        return None
    return quad


def paint_near(
    car: Detection, segs: np.ndarray, width: int, height: int
) -> list[tuple[float, ...]]:
    """The painted line pieces next to a car (photo fractions): its stall's dividers, where they
    show, and some edges of the car itself (the web weighs them by where they point)."""
    x0, y0, x1, y1 = car.box_xyxy
    bw, bh = x1 - x0, y1 - y0
    mx = (segs[:, 0] + segs[:, 2]) / 2
    my = (segs[:, 1] + segs[:, 3]) / 2
    length = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    near = (
        (mx >= x0 - PAINT_REACH * bw)
        & (mx <= x1 + PAINT_REACH * bw)
        & (my >= y0 - PAINT_REACH * bh)
        & (my <= y1 + PAINT_REACH * bh)
        & (length >= PAINT_MIN * bh)
    )
    return [
        (_frac(a, width), _frac(b, height), _frac(c, width), _frac(d, height))
        for a, b, c, d in segs[near, :4]
    ]


def car_stalls(
    cars: Sequence[Detection], width: int, height: int, bgr: np.ndarray | None = None
) -> list[ProposedStall]:
    """A stall per parked car, in rows by where the car stands on the photo (top to bottom, then
    left to right); `map_rect` is its box on the photo, for the web to straighten. With the photo,
    each also carries the paint next to it."""
    segs = segments(paint_mask(bgr)) if bgr is not None else np.zeros((0, 4), np.float32)
    found = [(c, q) for c in cars if (q := footprint(c, width, height)) is not None]
    if not found:
        return []
    found.sort(key=lambda cq: cq[0].box_xyxy[3])
    tall = float(np.median([c.box_xyxy[3] - c.box_xyxy[1] for c, _ in found]))
    rows: list[list[tuple[Detection, np.ndarray]]] = [[found[0]]]
    for cq in found[1:]:
        if cq[0].box_xyxy[3] - rows[-1][-1][0].box_xyxy[3] > ROW_GAP * tall:
            rows.append([cq])
        else:
            rows[-1].append(cq)
    out = []
    for r, row in enumerate(rows):
        for c, (car, quad) in enumerate(sorted(row, key=lambda cq: cq[0].box_xyxy[0])):
            x0, y0, x1, y1 = car.box_xyxy
            out.append(
                ProposedStall(
                    polygon=[(_frac(x, width), _frac(y, height)) for x, y in quad],
                    evidence=round(CAR_EVIDENCE * car.conf, 3),
                    row=r,
                    col=c,
                    map_rect=Rect(
                        x=round(x0 / width, 5),
                        y=round(y0 / width, 5),
                        w=round((x1 - x0) / width, 5),
                        h=round((y1 - y0) / width, 5),
                    ),
                    from_car=True,
                    paint=paint_near(car, segs, width, height) or None,
                )
            )
    return out
