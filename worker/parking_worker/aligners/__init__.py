from __future__ import annotations

from parking_core.interfaces import Aligner
from parking_core.settings import Adapters, Settings

from .identity import IdentityAligner
from .orb import OrbAligner


def build_aligner(settings: Settings, adapters: Adapters) -> Aligner:
    if settings.aligner == "orb":
        return OrbAligner(
            adapters.object_store,
            features=settings.orb_features,
            min_matches=settings.orb_min_matches,
            min_inliers=settings.orb_min_inliers,
            min_inlier_ratio=settings.orb_min_inlier_ratio,
            ransac_px=settings.orb_ransac_px,
        )
    return IdentityAligner()


__all__ = ["IdentityAligner", "OrbAligner", "build_aligner"]
