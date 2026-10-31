"""The state drivers see: readings per viewpoint, fused, then admin overrides, then closures."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from botocore.stub import Stubber
from parking_core import keys
from parking_core.adapters import aws
from parking_core.adapters.memory import MemoryRepository
from parking_core.models import (
    Closure,
    ClosureReason,
    Lot,
    ParkingSpace,
    PublishedLayout,
    Rect,
    SpaceState,
    SpaceStatus,
    StateOverride,
)
from parking_core.settings import Settings
from parking_core.status import build_status, lot_summary

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


def make_lot() -> Lot:
    return Lot(lot_id="L", name="Lot", stale_after_minutes=30, created_at=NOW)


def make_layout(n: int) -> PublishedLayout:
    spaces = [
        ParkingSpace(lot_id="L", space_id=f"s{i}", label=str(i), rect=Rect(x=0, y=0, w=1, h=1))
        for i in range(n)
    ]
    return PublishedLayout(
        lot_id="L", version=3, spaces=spaces, viewpoints=[], published_at=NOW, published_by="a"
    )


FREE, OCC, UNK, CLOSED = (
    SpaceState.FREE,
    SpaceState.OCCUPIED,
    SpaceState.UNKNOWN,
    SpaceState.CLOSED,
)
AWS_SETTINGS = Settings(app_env="local", queue_url="http://sqs.local/q", _env_file=None)  # type: ignore[call-arg]


def reading(sid: str, state: SpaceState, view: str | None, age_min: float = 1) -> SpaceStatus:
    return SpaceStatus(
        lot_id="L",
        space_id=sid,
        state=state,
        confidence=0.5,
        observed_at=NOW - timedelta(minutes=age_min),
        source_image_id=f"img-{view}",
        view_id=view,
    )


def override(sids, state=OCC, oid="ov_1", ends_in_min: float | None = 60, **kw) -> StateOverride:
    return StateOverride(
        lot_id="L",
        override_id=oid,
        space_ids=sids,
        state=state,
        note="event staff",
        starts_at=kw.pop("starts_at", NOW - timedelta(minutes=5)),
        ends_at=None if ends_in_min is None else NOW + timedelta(minutes=ends_in_min),
        created_by="a@x.edu",
        created_at=NOW,
        **kw,
    )


def closure(sids) -> Closure:
    return Closure(
        lot_id="L",
        closure_id="cl_1",
        space_ids=sids,
        reason=ClosureReason.EVENT,
        starts_at=NOW - timedelta(minutes=1),
        created_by="a",
        created_at=NOW,
    )


def rows(statuses, closures=(), overrides=()):
    out = build_status(make_lot(), make_layout(3), statuses, list(closures), [], NOW, overrides)
    return {r["spaceId"]: r for r in out["spaces"]}, out


# --- storage: one reading per space and viewpoint ---


def test_views_never_overwrite_each_other_memory():
    repo = MemoryRepository()
    assert repo.update_status_if_newer(reading("s0", OCC, "V1", age_min=5))
    assert repo.update_status_if_newer(reading("s0", UNK, "V2", age_min=0))  # its own item
    assert not repo.update_status_if_newer(reading("s0", FREE, "V1", age_min=6))  # older, V1
    got = {(s.view_id, s.state) for s in repo.get_statuses("L")}
    assert got == {("V1", OCC), ("V2", UNK)}


def test_status_item_key_has_the_view():
    assert keys.status_sk("s0") == "STATUS#s0"  # readings stored before views
    assert keys.status_sk("s0", "V2") == "STATUS#s0#V2"
    item = aws.status_item(reading("s0", FREE, "V2"))
    assert item["SK"] == "STATUS#s0#V2" and item["viewId"] == "V2"
    assert "viewId" not in aws.status_item(reading("s0", FREE, None))


def test_overrides_round_trip_memory():
    repo = MemoryRepository()
    repo.put_override(override(["s0"]))
    repo.put_override(override(["s1"], oid="ov_2"))
    repo.put_override(override(["s0"]).model_copy(update={"ended_at": NOW}))
    got = {o.override_id: o for o in repo.list_overrides("L")}
    assert set(got) == {"ov_1", "ov_2"} and got["ov_1"].ended_at == NOW
    assert repo.list_overrides("other") == []


def test_overrides_dynamo(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    repo = aws.DynamoRepository(AWS_SETTINGS)
    item = aws.override_item(override(["s0"]))
    assert item["SK"] == "OVERRIDE#ov_1" and item["state"] == "OCCUPIED"
    assert aws.item_to_model(item, StateOverride) == override(["s0"])
    with Stubber(repo._table.meta.client) as stub:
        stub.add_response("put_item", {})
        repo.put_override(override(["s0"]))
        stub.assert_no_pending_responses()


# --- the state shown ---


def test_two_viewpoints_complement():
    by_id, out = rows(
        [
            reading("s0", OCC, "V1", age_min=5),
            reading("s0", UNK, "V2", age_min=0),  # V2 sees s0 badly; it stays Occupied
            reading("s1", FREE, "V2", age_min=0),  # only V2 sees s1
        ]
    )
    assert by_id["s0"]["state"] is OCC and by_id["s0"]["views"] == ["V1"]
    assert by_id["s0"]["source"] == "camera"
    assert by_id["s1"]["state"] is FREE and by_id["s1"]["views"] == ["V2"]
    assert by_id["s2"]["state"] is UNK and by_id["s2"]["source"] is None
    assert out["counts"] == {"free": 1, "occupied": 1, "unknown": 1, "closed": 0}


def test_admin_override_beats_the_cameras():
    by_id, out = rows(
        [reading("s0", FREE, "V1"), reading("s1", FREE, "V1", age_min=90)],
        overrides=[override(["s0", "s1"], OCC)],
    )
    for sid in ("s0", "s1"):
        assert by_id[sid]["state"] is OCC and by_id[sid]["source"] == "admin"
        assert by_id[sid]["stale"] is False  # an admin's word is never out of date
        assert by_id[sid]["override"] == {
            "state": OCC,
            "endsAt": NOW + timedelta(minutes=60),
            "note": "event staff",
        }
    assert out["isStale"] is False


def test_closure_beats_an_override():
    by_id, _ = rows([reading("s0", FREE, "V1")], [closure(["s0"])], [override(["s0"], OCC)])
    assert by_id["s0"]["state"] is CLOSED and by_id["s0"]["source"] == "closure"
    assert by_id["s0"]["override"] is None


def test_ended_expired_and_future_overrides_do_not_apply():
    by_id, _ = rows(
        [reading("s0", FREE, "V1"), reading("s1", FREE, "V1"), reading("s2", FREE, "V1")],
        overrides=[
            override(["s0"], OCC, ended_at=NOW - timedelta(minutes=1)),
            override(["s1"], OCC, oid="ov_2", ends_in_min=-1),
            override(["s2"], OCC, oid="ov_3", starts_at=NOW + timedelta(minutes=5)),
        ],
    )
    assert all(by_id[s]["state"] is FREE and by_id[s]["source"] == "camera" for s in by_id)


def test_overlapping_overrides_latest_start_wins():
    early = override(["s0"], FREE, oid="ov_a", starts_at=NOW - timedelta(minutes=30))
    late = override(["s0"], OCC, oid="ov_b", starts_at=NOW - timedelta(minutes=2))
    for order in ([early, late], [late, early]):
        by_id, _ = rows([], overrides=order)
        assert by_id["s0"]["state"] is OCC


def test_lot_summary_counts_overrides():
    summary = lot_summary(
        make_lot(),
        make_layout(3),
        [reading("s0", FREE, "V1"), reading("s1", FREE, "V1"), reading("s2", FREE, "V1")],
        [],
        NOW,
        [override(["s0", "s1"], OCC)],
    )
    assert summary["occupied"] == 2 and summary["free"] == 1 and summary["openPercent"] == 33
