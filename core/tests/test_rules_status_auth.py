from datetime import UTC, datetime, timedelta

import jwt
import pytest
from parking_core.auth import DevJwtSigner, HS256Verifier, dev_users
from parking_core.models import (
    Closure,
    ClosureReason,
    Cutoffs,
    JobStatus,
    Lot,
    ParkingSpace,
    PublishedLayout,
    Rect,
    Snapshot,
    SpaceState,
    SpaceStatus,
)
from parking_core.settings import Settings
from parking_core.state_rules import decide_state
from parking_core.status import build_status, lot_summary

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)
C = Cutoffs()
LOOSE = Cutoffs(require_car_check=False)
SECRET = "test-secret-at-least-32-bytes-long!!"


@pytest.mark.parametrize(
    ("score", "overlap", "in_frame", "cutoffs", "expected"),
    [
        (0.9, 0.0, True, C, SpaceState.OCCUPIED),
        (0.1, 0.5, True, C, SpaceState.OCCUPIED),
        (0.1, 0.30, True, C, SpaceState.OCCUPIED),
        (None, 0.4, True, C, SpaceState.OCCUPIED),
        (0.1, 0.0, True, C, SpaceState.FREE),
        (0.1, 0.05, True, C, SpaceState.FREE),
        (0.1, 0.1, True, C, SpaceState.UNKNOWN),
        (0.1, 0.0, False, C, SpaceState.UNKNOWN),
        (0.5, 0.0, True, C, SpaceState.UNKNOWN),
        (0.7, 0.0, True, C, SpaceState.UNKNOWN),
        (0.3, 0.0, True, C, SpaceState.UNKNOWN),
        (None, None, True, C, SpaceState.UNKNOWN),
        (None, 0.0, True, C, SpaceState.UNKNOWN),
        (0.1, None, True, C, SpaceState.UNKNOWN),
        (0.1, None, True, LOOSE, SpaceState.FREE),
        (0.1, None, False, LOOSE, SpaceState.UNKNOWN),
        (0.9, None, True, LOOSE, SpaceState.OCCUPIED),
    ],
)
def test_decide_state(score, overlap, in_frame, cutoffs, expected):
    assert decide_state(score, overlap, in_frame, cutoffs) is expected


# --- status -------------------------------------------------------------------


def make_lot(**kw):
    return Lot(lot_id="L", name="Lot", stale_after_minutes=30, created_at=NOW, **kw)


def make_layout(n, retired=()):
    spaces = [
        ParkingSpace(
            lot_id="L",
            space_id=f"s{i}",
            label=str(i),
            rect=Rect(x=0, y=0, w=1, h=1),
            retired=f"s{i}" in retired,
        )
        for i in range(n)
    ]
    return PublishedLayout(
        lot_id="L",
        version=3,
        spaces=spaces,
        viewpoints=[],
        published_at=NOW,
        published_by="a",
    )


def st(sid, state, age_min=1, conf=0.5):
    return SpaceStatus(
        lot_id="L",
        space_id=sid,
        state=state,
        confidence=conf,
        observed_at=NOW - timedelta(minutes=age_min),
        source_image_id="img",
    )


def snap(status):
    return Snapshot(
        image_id="i",
        lot_id="L",
        view_id="v",
        capture_time=NOW,
        sha256="0" * 64,
        s3_key="raw/L/v/i.jpg",
        content_type="image/jpeg",
        size_bytes=1,
        uploaded_by="a",
        job_status=status,
        created_at=NOW,
    )


def closure(space_ids, **kw):
    base = dict(
        lot_id="L",
        closure_id="c1",
        space_ids=space_ids,
        reason=ClosureReason.EVENT,
        starts_at=NOW - timedelta(hours=1),
        ends_at=NOW + timedelta(hours=1),
        created_by="a",
        created_at=NOW,
    )
    base.update(kw)
    return Closure(**base)


def test_build_status_counts_and_stale():
    statuses = [
        st("s0", SpaceState.FREE),
        st("s1", SpaceState.OCCUPIED, age_min=45),
        st("s2", SpaceState.UNKNOWN),
    ]
    out = build_status(make_lot(), make_layout(4, retired={"s3"}), statuses, [], [], NOW)
    assert [s["spaceId"] for s in out["spaces"]] == ["s0", "s1", "s2"]
    assert out["counts"] == {"free": 1, "occupied": 1, "unknown": 1, "closed": 0}
    assert [s["stale"] for s in out["spaces"]] == [False, True, False]
    assert out["isStale"] is True
    assert out["noObservations"] is False
    assert out["lastObservedAt"] == NOW - timedelta(minutes=1)
    assert out["layoutVersion"] == 3
    assert out["processing"] is False
    assert out["spaces"][0]["score"] == 0.5


def test_build_status_no_observations():
    out = build_status(make_lot(), make_layout(2), [], [], [], NOW)
    assert out["noObservations"] is True
    assert out["isStale"] is False
    assert out["lastObservedAt"] is None
    assert all(s["state"] is SpaceState.UNKNOWN and s["stale"] for s in out["spaces"])
    assert out["counts"]["unknown"] == 2


def test_build_status_closure_overlay():
    statuses = [st("s0", SpaceState.FREE, age_min=90), st("s1", SpaceState.FREE)]
    closures = [
        closure(["s0"]),
        closure(["s1"], closure_id="old", ends_at=NOW - timedelta(minutes=1)),
    ]
    out = build_status(make_lot(), make_layout(2), statuses, closures, [], NOW)
    s0, s1 = out["spaces"]
    assert s0["state"] is SpaceState.CLOSED
    assert s0["stale"] is False
    assert s0["closure"] == {"reason": ClosureReason.EVENT, "endsAt": NOW + timedelta(hours=1)}
    assert s1["state"] is SpaceState.FREE and s1["closure"] is None
    assert out["counts"] == {"free": 1, "occupied": 0, "unknown": 0, "closed": 1}
    assert out["isStale"] is False  # the only old observation is on a closed space


def test_overlapping_closures_pick_deterministically():
    later = NOW + timedelta(hours=5)
    timed = [
        closure(["s0"], closure_id="b", reason=ClosureReason.MAINTENANCE, ends_at=later),
        closure(["s0"], closure_id="a", reason=ClosureReason.RESERVED, ends_at=later),
        closure(["s0"], closure_id="c", reason=ClosureReason.EVENT),
    ]
    open_ended = closure(["s0"], closure_id="z", reason=ClosureReason.CONSTRUCTION, ends_at=None)
    for order in (timed, timed[::-1]):
        s0 = build_status(make_lot(), make_layout(1), [], order, [], NOW)["spaces"][0]
        assert s0["closure"] == {"reason": ClosureReason.RESERVED, "endsAt": later}
        s0 = build_status(make_lot(), make_layout(1), [], [*order, open_ended], [], NOW)
        assert s0["spaces"][0]["closure"] == {
            "reason": ClosureReason.CONSTRUCTION,
            "endsAt": None,
        }


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (JobStatus.QUEUED, True),
        (JobStatus.PROCESSING, True),
        (JobStatus.COMPLETE, False),
        (JobStatus.FAILED, False),
        (JobStatus.UPLOAD_PENDING, False),
    ],
)
def test_build_status_processing(status, expected):
    out = build_status(make_lot(), make_layout(1), [], [], [snap(status)], NOW)
    assert out["processing"] is expected


def test_lot_summary_math():
    statuses = (
        [st(f"s{i}", SpaceState.FREE) for i in range(5)]
        + [st(f"s{i}", SpaceState.OCCUPIED) for i in range(5, 15)]
        + [st(f"s{i}", SpaceState.UNKNOWN) for i in range(15, 18)]
    )
    out = lot_summary(make_lot(), make_layout(20), statuses, [closure(["s18", "s19"])], NOW)
    assert out == {
        "free": 5,
        "occupied": 10,
        "unknown": 3,
        "closed": 2,
        "total": 18,
        "openPercent": 28,
        "isStale": False,
        "hasRecentData": True,
    }


def test_lot_summary_without_recent_data():
    out = lot_summary(make_lot(), make_layout(2), [st("s0", SpaceState.FREE, 60)], [], NOW)
    assert out["openPercent"] is None
    assert out["hasRecentData"] is False
    assert out["isStale"] is True
    empty = lot_summary(make_lot(), make_layout(2), [], [], NOW)
    assert empty["openPercent"] is None and empty["isStale"] is False


# --- auth -------------------------------------------------------------------


def test_jwt_round_trip():
    token, expires = DevJwtSigner(SECRET, 60).sign("a@x.edu", ["admin"])
    p = HS256Verifier(SECRET).verify(token)
    assert p is not None and p.email == "a@x.edu" and p.is_admin and not p.expired
    assert expires > datetime.now(UTC)


def test_jwt_expired():
    token, _ = DevJwtSigner(SECRET, 5).sign("a@x.edu", [], now=NOW - timedelta(days=1))
    p = HS256Verifier(SECRET).verify(token)
    assert p is not None and p.expired and p.email == "a@x.edu"


@pytest.mark.parametrize(
    "token",
    ["garbage", "", jwt.encode({"email": "a@x.edu"}, "other", algorithm="HS256")],
)
def test_jwt_malformed(token):
    assert HS256Verifier(SECRET).verify(token) is None


def test_jwt_without_exp_is_rejected():
    token = jwt.encode({"email": "a@x.edu", "groups": ["admin"]}, SECRET, algorithm="HS256")
    assert HS256Verifier(SECRET).verify(token) is None


def test_dev_users():
    users = dev_users(Settings(app_env="test", _env_file=None))
    s = Settings(app_env="test", _env_file=None)
    assert users[s.dev_admin_email] == (s.dev_admin_password, ["admin"])
    assert users[s.dev_user_email] == (s.dev_user_password, [])


def test_build_status_processing_ignores_snapshot_older_than_data():
    """A queued photo captured before the newest observation will not change the map."""
    fresh = [st("s0", SpaceState.FREE, age_min=0)]  # observed_at == NOW == capture_time
    out = build_status(make_lot(), make_layout(1), fresh, [], [snap(JobStatus.QUEUED)], NOW)
    assert out["processing"] is False
    older = [st("s0", SpaceState.FREE, age_min=5)]
    out = build_status(make_lot(), make_layout(1), older, [], [snap(JobStatus.PROCESSING)], NOW)
    assert out["processing"] is True


def test_build_status_processing_sees_past_a_newer_unfinished_photo():
    """A newer photo that failed or was never uploaded does not hide an older one in flight."""
    older = [st("s0", SpaceState.FREE, age_min=10)]
    queued = snap(JobStatus.QUEUED).model_copy(update={"capture_time": NOW - timedelta(minutes=5)})
    for newer in (JobStatus.FAILED, JobStatus.UPLOAD_PENDING):
        out = build_status(make_lot(), make_layout(1), older, [], [snap(newer), queued], NOW)
        assert out["processing"] is True
