"""Stalls hidden behind foliage (HDD §4.5): what the scorer can't see, it must not call.

A tree over a stall hides the paint and any car in it. ACPDS still returns a score for the
crop (on the UFPR04 camera photo, leaves read Free on one stall and Occupied on the next), so
a stall mostly covered by foliage gets no ACPDS score: a car the detector does see there still
marks it Occupied, and otherwise the state rule reports it Unknown.

Foliage is told by colour: a green hue, saturated enough not to be asphalt under a colour cast
and dark enough not to be a bright green car. Measured on the UFPR04 photo (six stalls under two
trees: 0.50 to 0.98 covered, every other stall 0.36 or less), the drone lot (nothing over 0.25)
and a top-down lot with a lime car and a green van (0.35 at most). Other obstacles (a pole, a
truck in the aisle) are not recognised; the admin's "Set space state" covers those.
"""

from __future__ import annotations

from collections.abc import Sequence

import cv2
import numpy as np
from parking_core.models import AlignedOutline

HUE_DEG = (50.0, 160.0)
"""Green, from yellow-green leaves to blue-green needles."""
MIN_SATURATION = 0.2
"""Below this a green hue is a colour cast on asphalt, paint or a grey car."""
MAX_VALUE = 0.7
"""Above this a saturated green is a bright car, not leaves."""
HIDDEN_SHARE = 0.5
"""A stall with at least this share of its outline under foliage is hidden."""


def foliage_mask(bgr: np.ndarray) -> np.ndarray:
    """Pixels that look like foliage: ``H x W`` uint8, 255 where they do."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)  # H in half degrees, S and V in 0..255
    low = (round(HUE_DEG[0] / 2), int(MIN_SATURATION * 255) + 1, 0)
    high = (round(HUE_DEG[1] / 2), 255, int(MAX_VALUE * 255))
    return cv2.inRange(hsv, low, high)


def foliage_shares(bgr: np.ndarray, outlines: Sequence[AlignedOutline]) -> list[float]:
    """The share of each outline's pixels on the photo that foliage covers (0 for one with no
    pixels on the photo)."""
    height, width = bgr.shape[:2]
    mask = foliage_mask(bgr)
    shares: list[float] = []
    for outline in outlines:
        pts = np.asarray(outline.polygon, dtype=np.float64).reshape(-1, 2) * [width, height]
        if len(pts) < 3:
            shares.append(0.0)
            continue
        x0, y0 = np.floor(pts.min(axis=0)).astype(int)
        x1, y1 = np.ceil(pts.max(axis=0)).astype(int)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, width), min(y1, height)
        if x1 <= x0 or y1 <= y0:
            shares.append(0.0)
            continue
        stall = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
        cv2.fillPoly(stall, [np.round(pts - [x0, y0]).astype(np.int32)], 1)
        area = int(stall.sum())
        covered = int(np.count_nonzero(mask[y0:y1, x0:x1][stall > 0]))
        shares.append(covered / area if area else 0.0)
    return shares


def hidden_by_foliage(bgr: np.ndarray, outlines: Sequence[AlignedOutline]) -> list[bool]:
    """Which outlines are mostly under foliage on this photo."""
    return [share >= HIDDEN_SHARE for share in foliage_shares(bgr, outlines)]
