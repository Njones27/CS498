"""The divider frame: the photo rotated so stall dividers run vertically and rows horizontally.

Rows, pitch and stall rectangles are all worked out in this frame (axis-aligned there), then
mapped back to the photo. It is a pure rotation, so lengths are photo pixels.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class Frame:
    """Affine photo -> frame map. ``size`` is the frame canvas (width, height) in px."""

    matrix: np.ndarray  # 2 x 3, photo px -> frame px
    inverse: np.ndarray  # 2 x 3, frame px -> photo px
    size: tuple[int, int]
    photo_size: tuple[int, int]  # (width, height)
    rotation_deg: float

    def to_frame(self, pts: np.ndarray) -> np.ndarray:
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        return pts @ self.matrix[:, :2].T + self.matrix[:, 2]

    def to_photo(self, pts: np.ndarray) -> np.ndarray:
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        return pts @ self.inverse[:, :2].T + self.inverse[:, 2]

    def warp(self, image: np.ndarray) -> np.ndarray:
        """Warp a mask into the frame (nearest neighbour keeps it binary)."""
        if self.rotation_deg == 0.0:
            return image
        return cv2.warpAffine(image, self.matrix, self.size, flags=cv2.INTER_NEAREST)

    def in_photo(self, pts: np.ndarray, margin: float = 0.0) -> np.ndarray:
        """Whether frame points map inside the photo (shrunk by ``margin`` px)."""
        p = self.to_photo(pts)
        w, h = self.photo_size
        return (
            (p[:, 0] >= margin)
            & (p[:, 0] <= w - margin)
            & (p[:, 1] >= margin)
            & (p[:, 1] <= h - margin)
        )


def make_frame(divider_deg: float | None, width: int, height: int) -> Frame:
    """Rotate by ``90 - divider_deg`` so the dividers' direction becomes vertical.

    ``divider_deg`` is in [0, 180), so the rotation is within (-90, 90]: the smallest turn,
    which keeps "top of the photo" near the top of the frame.
    """
    theta = 0.0 if divider_deg is None else 90.0 - divider_deg
    if abs(theta) < 0.05:
        theta = 0.0
    rad = math.radians(theta)
    c, s = math.cos(rad), math.sin(rad)
    rot = np.array([[c, -s], [s, c]])
    corners = np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float64)
    turned = corners @ rot.T
    lo = turned.min(axis=0)
    size = np.ceil(turned.max(axis=0) - lo).astype(int)
    matrix = np.hstack([rot, -lo[:, None]])
    inverse = np.hstack([rot.T, (rot.T @ lo)[:, None]])
    if theta == 0.0:
        size = np.array([width, height])
    return Frame(matrix, inverse, (int(size[0]), int(size[1])), (width, height), theta)
