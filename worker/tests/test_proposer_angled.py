"""Stalls from parked cars, for a photo taken at an angle (proposer/angled.py)."""

from __future__ import annotations

import math

import cv2
import numpy as np
from parking_worker.proposer.angled import car_stalls, footprint, paint_misses_cars, parked_cars
from parking_worker.proposer.proposer import propose_stalls
from parking_worker.scorers.acpds_yolo import Detection

W, H = 1280, 720


def tilted_car(cx: float, cy: float, deg: float, cls: str = "car", conf: float = 0.9) -> Detection:
    """A car seen at an angle: a 90 x 40 px mask turned `deg` degrees, cropped to its box."""
    rect = ((cx, cy), (90, 40), deg)
    pts = cv2.boxPoints(rect)
    x0, y0 = np.floor(pts.min(axis=0)).astype(int)
    x1, y1 = np.ceil(pts.max(axis=0)).astype(int)
    mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
    cv2.fillPoly(mask, [np.round(pts - [x0, y0]).astype(np.int32)], 1)
    return Detection(
        cls,
        conf,
        (float(x0), float(y0), float(x1), float(y1)),
        mask.astype(bool),
        (int(x0), int(y0)),
    )


def test_a_car_is_outlined_along_its_angle():
    quad = footprint(tilted_car(400, 300, 30), W, H)
    assert quad is not None
    side = quad[1] - quad[0]
    long = side if np.hypot(*side) > np.hypot(*(quad[3] - quad[0])) else quad[3] - quad[0]
    angle = math.degrees(math.atan2(long[1], long[0])) % 180
    assert abs(angle - 30) < 3
    assert np.hypot(*long) > 85


def test_a_box_without_a_mask_is_its_outline():
    car = Detection("car", 0.9, (100.0, 200.0, 190.0, 240.0))
    quad = footprint(car, W, H)
    assert quad is not None and quad.tolist() == [[100, 200], [190, 200], [190, 240], [100, 240]]


def test_only_confident_cars_count():
    dets = [
        tilted_car(100, 100, 0),
        tilted_car(200, 100, 0, conf=0.2),
        tilted_car(300, 100, 0, cls="person"),
    ]
    assert len(parked_cars(dets)) == 1


def test_cars_outside_the_paint_replace_it_with_a_stall_per_car():
    """No paint at all on a photo with eight parked cars in two rows: one stall per car, flagged
    from_car, in photo rows top to bottom; the web straightens them."""
    cars = [
        tilted_car(200 + 110 * k, 250 + 160 * r + 8 * k, 35) for r in range(2) for k in range(4)
    ]
    blank = np.full((H, W, 3), 95, np.uint8)
    stalls = propose_stalls(blank, cars)
    assert len(stalls) == 8 and all(s.from_car for s in stalls)
    assert sorted({s.row for s in stalls}) == [0, 1]
    assert all(0 <= x <= 1 and 0 <= y <= 1 for s in stalls for x, y in s.polygon)
    assert max(s.evidence for s in stalls) <= 0.4


def test_paint_that_holds_the_cars_stands():
    """Cars in the painted stalls leave the paint layout alone; too few cars never replace it."""
    painted = [car_stalls([tilted_car(200 + 110 * k, 300, 0)], W, H)[0] for k in range(6)]
    cars = [tilted_car(200 + 110 * k, 300, 0) for k in range(6)]
    assert not paint_misses_cars(painted, cars, W, H)
    assert paint_misses_cars([], cars, W, H)
    assert not paint_misses_cars([], cars[:5], W, H)


def test_a_car_stall_carries_the_paint_beside_it():
    """The painted divider next to a car rides along with its stall (photo fractions); paint far
    from every car does not."""
    rng = np.random.default_rng(0)
    img = np.clip(rng.normal(95, 6, (H, W, 3)), 0, 255).astype(np.uint8)  # asphalt
    cv2.line(img, (300, 200), (360, 320), (235, 235, 235), 4)  # beside the car
    cv2.line(img, (1000, 600), (1100, 650), (235, 235, 235), 4)  # nowhere near it
    stall = car_stalls([tilted_car(400, 260, 60)], W, H, img)[0]
    assert stall.paint
    for x1, y1, x2, y2 in stall.paint:
        assert 250 / W < min(x1, x2) and max(x1, x2) < 400 / W
        assert 180 / H < min(y1, y2) and max(y1, y2) < 340 / H
