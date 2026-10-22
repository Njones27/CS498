"""Scripted scorer for tests: fixed results per space, a function, or a raised error."""

from __future__ import annotations

from collections.abc import Callable

from parking_core.models import AlignedOutline, SpaceScore

ScoreFn = Callable[[AlignedOutline], SpaceScore]


class FakeScorer:
    def __init__(
        self,
        results: dict[str, SpaceScore] | ScoreFn | None = None,
        raise_exc: BaseException | None = None,
        model_version: str = "fake",
    ) -> None:
        self.results = results if results is not None else {}
        self.raise_exc = raise_exc
        self.model_version = model_version
        self.calls: list[list[AlignedOutline]] = []

    def score(self, image: bytes, outlines: list[AlignedOutline]) -> list[SpaceScore]:
        self.calls.append(outlines)
        if self.raise_exc is not None:
            raise self.raise_exc
        if callable(self.results):
            return [self.results(o) for o in outlines]
        return [
            self.results[o.space_id].model_copy(update={"space_id": o.space_id})
            for o in outlines
            if o.space_id in self.results
        ]
