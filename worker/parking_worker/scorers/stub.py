"""Deterministic stand-in for ACPDS + YOLO (wave 1). Never lands in the UNKNOWN band."""

from __future__ import annotations

import hashlib

from parking_core.models import AlignedOutline, SpaceScore


class StubScorer:
    def __init__(self, model_version: str = "stub-0") -> None:
        self.model_version = model_version

    def score(self, image: bytes, outlines: list[AlignedOutline]) -> list[SpaceScore]:
        image_key = hashlib.sha256(image).hexdigest()[:16]
        return [self._score_one(image_key, o) for o in outlines]

    @staticmethod
    def _score_one(image_key: str, outline: AlignedOutline) -> SpaceScore:
        digest = hashlib.sha256(f"{image_key}:{outline.space_id}".encode()).digest()
        fraction = int.from_bytes(digest[1:3], "big") / 0xFFFF  # 0..1
        if digest[0] % 2 == 1:
            score, overlap = 0.8 + 0.2 * fraction, 1.0
        else:
            score, overlap = 0.2 * fraction, 0.0
        return SpaceScore(
            space_id=outline.space_id,
            acpds_score=score,
            car_overlap=overlap,
            in_frame=outline.in_frame,
        )
