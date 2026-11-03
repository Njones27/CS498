"""Layout proposer (HDD §4.6): stall outlines from one reference photo, for admin review."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from .proposer import LayoutProposerImpl, propose_stalls

if TYPE_CHECKING:
    import numpy as np
    from parking_core.interfaces import LayoutProposer
    from parking_core.settings import Settings

    from ..scorers.acpds_yolo import CarDetector, Detection


class SegCars:  # pragma: no cover - needs ultralytics and the weights
    """YOLO with masks, for the proposer only, loaded on the first photo it looks at: a car's
    mask gives its angle on a photo taken at an angle (`angled.footprint`). The scorer keeps its
    own box model, so scoring is unchanged; Find stalls is rare, so the second model costs
    memory only once an admin uses it."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model: CarDetector | None = None

    def __call__(self, bgr: np.ndarray) -> list[Detection]:
        if self.model is None:
            from ..cpu_quota import limit_threads_to_quota
            from ..scorers.acpds_yolo import YoloCarDetector, verify_weights

            s = self.settings
            path, _ = verify_weights(Path(s.models_dir), s.yolo_seg_weights)
            self.model = YoloCarDetector(path, conf=s.yolo_conf, seg=True, imgsz=s.yolo_imgsz)
            limit_threads_to_quota()  # the model's warm-up resets torch to the host's cores
        return self.model(bgr)


def build_proposer(settings: Settings, car_detector: CarDetector | None = None) -> LayoutProposer:
    """The proposer the worker runs. Paint alone without a detector; with one, parked cars add
    rows, fills and evidence, and on a photo taken at an angle stand in for the paint."""
    del settings  # nothing tunable yet; kept so tuning knobs can land without a call change
    return LayoutProposerImpl(car_detector)


__all__ = ["LayoutProposerImpl", "SegCars", "build_proposer", "propose_stalls"]
