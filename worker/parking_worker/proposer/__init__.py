"""Layout proposer (HDD §4.6): stall outlines from one overhead photo, for admin review."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .proposer import LayoutProposerImpl, propose_stalls

if TYPE_CHECKING:
    from parking_core.interfaces import LayoutProposer
    from parking_core.settings import Settings

    from ..scorers.acpds_yolo import CarDetector


def build_proposer(settings: Settings, car_detector: CarDetector | None = None) -> LayoutProposer:
    """The proposer the worker runs. Paint alone without a detector; with the scorer's loaded
    YOLO (``DETECTOR=acpds_yolo``) parked cars add rows, fills and evidence."""
    del settings  # nothing tunable yet; kept so tuning knobs can land without a call change
    return LayoutProposerImpl(car_detector)


__all__ = ["LayoutProposerImpl", "build_proposer", "propose_stalls"]
