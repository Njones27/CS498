"""Foliage over a stall (scorers/occlusion): colour rule and per-outline share."""

from __future__ import annotations

import cv2
import numpy as np
import pytest
from parking_core.models import AlignedOutline
from parking_worker.scorers.occlusion import (
    HIDDEN_SHARE,
    foliage_mask,
    foliage_shares,
    hidden_by_foliage,
)


def hsv_pixel(hue_deg: float, saturation: float, value: float) -> np.ndarray:
    """A 1 x 1 BGR image of that colour."""
    hsv = np.array([[[round(hue_deg / 2), round(saturation * 255), round(value * 255)]]], np.uint8)
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)


@pytest.mark.parametrize(
    ("what", "hue", "saturation", "value", "foliage"),
    [
        ("pine needles", 80, 0.40, 0.33, True),
        ("yellow-green leaves", 60, 0.35, 0.55, True),
        ("leaves in shade", 95, 0.30, 0.25, True),
        ("asphalt under a green cast", 75, 0.10, 0.60, False),
        ("white paint under a green cast", 75, 0.08, 0.85, False),
        ("lime car", 82, 0.55, 0.90, False),
        ("teal car", 190, 0.60, 0.40, False),
        ("red car", 0, 0.80, 0.70, False),
        ("black car", 0, 0.00, 0.10, False),
    ],
)
def test_foliage_is_green_saturated_and_not_bright(what, hue, saturation, value, foliage):
    assert bool(foliage_mask(hsv_pixel(hue, saturation, value))[0, 0]) is foliage, what


def outline(polygon) -> AlignedOutline:
    return AlignedOutline(space_id="S", polygon=polygon, in_frame=True)


def photo_with_tree() -> np.ndarray:
    """100 x 100 asphalt with foliage over the left half."""
    bgr = np.full((100, 100, 3), 120, np.uint8)
    bgr[:, :50] = (40, 90, 60)
    return bgr


def test_share_is_the_part_of_the_outline_under_foliage():
    bgr = photo_with_tree()
    under = outline([(0.1, 0.2), (0.4, 0.2), (0.4, 0.6), (0.1, 0.6)])
    half = outline([(0.3, 0.2), (0.7, 0.2), (0.7, 0.6), (0.3, 0.6)])
    clear = outline([(0.6, 0.2), (0.9, 0.2), (0.9, 0.6), (0.6, 0.6)])
    shares = foliage_shares(bgr, [under, half, clear])
    assert shares[0] == pytest.approx(1.0) and shares[2] == 0.0
    assert shares[1] == pytest.approx(0.5, abs=0.05)
    mostly = outline([(0.2, 0.2), (0.6, 0.2), (0.6, 0.6), (0.2, 0.6)])  # three quarters under
    assert hidden_by_foliage(bgr, [under, mostly, clear]) == [True, True, False]
    assert foliage_shares(bgr, [mostly])[0] >= HIDDEN_SHARE


def test_outline_off_the_photo_or_without_area_has_no_share():
    bgr = photo_with_tree()
    off = outline([(1.2, 0.2), (1.5, 0.2), (1.5, 0.6), (1.2, 0.6)])
    line = outline([(0.1, 0.2), (0.4, 0.2)])
    hanging = outline([(-0.3, 0.2), (0.3, 0.2), (0.3, 0.6), (-0.3, 0.6)])  # the part in view
    assert foliage_shares(bgr, [off, line]) == [0.0, 0.0]
    assert foliage_shares(bgr, [hanging])[0] == pytest.approx(1.0)
