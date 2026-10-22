from __future__ import annotations

from parking_core.interfaces import SpaceScorer
from parking_core.settings import Settings

from .fake import FakeScorer
from .stub import StubScorer


def build_scorer(settings: Settings) -> SpaceScorer:
    if settings.detector == "stub":
        return StubScorer()
    raise NotImplementedError("acpds_yolo arrives in wave 2")


__all__ = ["FakeScorer", "StubScorer", "build_scorer"]
