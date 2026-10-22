from __future__ import annotations

from parking_core.interfaces import SpaceScorer
from parking_core.settings import Settings

from .fake import FakeScorer
from .stub import StubScorer


def build_scorer(settings: Settings) -> SpaceScorer:
    if settings.detector == "stub":
        return StubScorer()
    # Imported here so the stub worker (and CI) never needs torch or ultralytics.
    from .acpds_yolo import AcpdsYoloScorer

    return AcpdsYoloScorer.from_settings(settings)


__all__ = ["FakeScorer", "StubScorer", "build_scorer"]
