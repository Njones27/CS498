"""Fusing every viewpoint's latest reading of a space into one state."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from parking_core.fusion import AGREEMENT_WINDOW, fuse, fuse_by_space
from parking_core.models import SpaceState, SpaceStatus

T = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)
AGE = timedelta(minutes=30)
FREE, OCC, UNK = SpaceState.FREE, SpaceState.OCCUPIED, SpaceState.UNKNOWN


def r(
    view: str | None, state: SpaceState, minutes_ago: float = 0, space: str = "s1"
) -> SpaceStatus:
    return SpaceStatus(
        lot_id="L",
        space_id=space,
        state=state,
        confidence=0.5,
        observed_at=T - timedelta(minutes=minutes_ago),
        source_image_id=f"img-{view}-{minutes_ago}",
        view_id=view,
    )


def test_no_readings():
    assert fuse([], AGE) is None


@pytest.mark.parametrize(
    ("readings", "state", "chosen_view", "views"),
    [
        # One viewpoint: its reading.
        ([r("V1", FREE)], FREE, "V1", ("V1",)),
        # A later Unknown from a view that sees the space badly keeps the confident state.
        ([r("V1", OCC, 5), r("V2", UNK, 0)], OCC, "V1", ("V1",)),
        # Two views agree.
        ([r("V1", FREE, 3), r("V2", FREE, 0)], FREE, "V2", ("V1", "V2")),
        # Disagreement at nearly the same moment: Occupied wins (a false Free costs most).
        ([r("V1", OCC, 4), r("V2", FREE, 0)], OCC, "V1", ("V1",)),
        ([r("V1", FREE, 4), r("V2", OCC, 0)], OCC, "V2", ("V2",)),
        # Free well after the other view's Occupied: the car left.
        ([r("V1", OCC, 15), r("V2", FREE, 0)], FREE, "V2", ("V2",)),
        # Only Unknown: the newest Unknown stands.
        ([r("V1", UNK, 5), r("V2", UNK, 0)], UNK, "V2", ("V1", "V2")),
        # A confident reading past the allowed age no longer counts.
        ([r("V1", OCC, 45), r("V2", UNK, 0)], UNK, "V2", ("V2",)),
        # A legacy reading (no viewpoint) counts, but may be this very view's older reading,
        # so it never overrules a newer Free.
        ([r(None, OCC, 2), r("V1", FREE, 0)], FREE, "V1", ("V1",)),
        ([r(None, OCC, 2), r("V1", UNK, 0)], OCC, None, ()),
    ],
)
def test_fuse(readings, state, chosen_view, views):
    fused = fuse(readings, AGE)
    assert fused is not None
    assert fused.state is state
    assert fused.reading.view_id == chosen_view
    assert fused.views == views


def test_agreement_window_edge():
    inside = fuse([r("V1", OCC, AGREEMENT_WINDOW.total_seconds() / 60), r("V2", FREE)], AGE)
    assert inside is not None and inside.state is OCC
    outside = fuse([r("V1", OCC, AGREEMENT_WINDOW.total_seconds() / 60 + 0.1), r("V2", FREE)], AGE)
    assert outside is not None and outside.state is FREE


def test_same_view_free_is_not_overruled_by_itself():
    # Only another viewpoint's Occupied overrules a Free (one view's readings are one series).
    fused = fuse([r("V1", OCC, 3), r("V1", FREE, 0)], AGE)
    assert fused is not None and fused.state is FREE


def test_fuse_by_space():
    out = fuse_by_space([r("V1", FREE, space="a"), r("V2", OCC, space="b")], AGE)
    assert {k: v.state for k, v in out.items()} == {"a": FREE, "b": OCC}
