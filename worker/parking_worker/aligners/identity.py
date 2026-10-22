"""Identity aligner: assumes the photo matches the reference exactly (wave 1).

ORB features + RANSAC homography (HDD §4.4) replace this in wave 2.
"""

from __future__ import annotations

from parking_core.models import AlignedOutline, Viewpoint


class IdentityAligner:
    def align(self, image: bytes, viewpoint: Viewpoint) -> list[AlignedOutline]:
        return [
            AlignedOutline(space_id=space_id, polygon=list(polygon), in_frame=True)
            for space_id, polygon in viewpoint.outlines.items()
        ]
