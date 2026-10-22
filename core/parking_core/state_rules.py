"""Per-space state rule (HDD §4.5). Asymmetric: wrongly saying FREE is the costly error."""

from __future__ import annotations

from .models import Cutoffs, SpaceState


def decide_state(
    acpds_score: float | None,
    car_overlap: float | None,
    in_frame: bool,
    cutoffs: Cutoffs,
) -> SpaceState:
    if (acpds_score is not None and acpds_score > cutoffs.high) or (
        car_overlap is not None and car_overlap >= cutoffs.overlap
    ):
        return SpaceState.OCCUPIED
    if in_frame and acpds_score is not None and acpds_score < cutoffs.low:
        if car_overlap is not None and car_overlap <= cutoffs.margin:
            return SpaceState.FREE
        if car_overlap is None and not cutoffs.require_car_check:
            return SpaceState.FREE
    return SpaceState.UNKNOWN
