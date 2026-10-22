from __future__ import annotations

from parking_core.models import AlignedOutline, Cutoffs, SpaceState, Viewpoint
from parking_core.state_rules import decide_state
from parking_worker.aligners import IdentityAligner
from parking_worker.scorers import StubScorer

SQUARE = [(0.1, 0.1), (0.2, 0.1), (0.2, 0.2), (0.1, 0.2)]


def outlines(n: int, in_frame: bool = True) -> list[AlignedOutline]:
    return [
        AlignedOutline(space_id=f"S-{i:03d}", polygon=SQUARE, in_frame=in_frame) for i in range(n)
    ]


def test_stub_is_deterministic():
    a = StubScorer().score(b"photo", outlines(20))
    b = StubScorer().score(b"photo", outlines(20))
    assert a == b
    assert a != StubScorer().score(b"other photo", outlines(20))


def test_stub_never_in_unknown_band():
    cutoffs = Cutoffs()
    scorer = StubScorer()
    states = []
    for i in range(200):
        for s in scorer.score(f"img-{i}".encode(), outlines(5)):
            assert s.acpds_score is not None
            assert 0.0 <= s.acpds_score <= 0.2 or 0.8 <= s.acpds_score <= 1.0
            assert not cutoffs.low <= s.acpds_score <= cutoffs.high
            states.append(decide_state(s.acpds_score, s.car_overlap, s.in_frame, cutoffs))
    assert SpaceState.UNKNOWN not in states
    assert SpaceState.FREE in states and SpaceState.OCCUPIED in states


def test_stub_passes_in_frame_through():
    assert all(not s.in_frame for s in StubScorer().score(b"x", outlines(5, in_frame=False)))
    assert StubScorer().model_version == "stub-0"


def test_identity_aligner_returns_every_outline():
    vp = Viewpoint(lot_id="l", view_id="V1", name="V1", outlines={"A": SQUARE, "B": SQUARE})
    out = IdentityAligner().align(b"x", vp)
    assert {o.space_id for o in out} == {"A", "B"}
    assert all(o.in_frame and o.polygon == SQUARE for o in out)
