"""US-10 closures: one test per acceptance criterion, plus errors and admin auth."""

from __future__ import annotations

from datetime import timedelta

import pytest
from parking_core.keys import layout_snapshot_key
from parking_core.models import SpaceState, SpaceStatus

from .conftest import NOW, token

URL = "/admin/lots/test-lot/closures"
ROW_B = [f"B-{n:02d}" for n in range(1, 8)]

CLOSURE_ROUTES = [
    ("get", URL, {}),
    ("post", URL, {"json": {}}),
    ("delete", f"{URL}/cl_x", {}),
]


def create(client, headers, space_ids, *, reason="EVENT", starts=NOW, ends=None, lot="test-lot"):
    payload = {
        "spaceIds": space_ids,
        "reason": reason,
        "startsAt": starts.isoformat(),
        "endsAt": ends.isoformat() if ends else None,
    }
    return client.post(f"/admin/lots/{lot}/closures", json=payload, headers=headers)


def spaces(client) -> dict[str, dict]:
    r = client.get("/lots/test-lot/status")
    assert r.status_code == 200, r.text
    return {s["spaceId"]: s for s in r.json()["spaces"]}


def detect(adapters, space_id, state=SpaceState.FREE, at=NOW - timedelta(minutes=5)):
    adapters.repository.update_status_if_newer(
        SpaceStatus(
            lot_id="test-lot", space_id=space_id, state=state, observed_at=at, source_image_id="i"
        )
    )


def test_close_a_row(client, admin_headers, adapters):
    for sid in ROW_B:
        detect(adapters, sid)
    detect(adapters, "A-01")
    r = create(
        client, admin_headers, ROW_B, starts=NOW - timedelta(hours=1), ends=NOW + timedelta(hours=8)
    )
    assert r.status_code == 201, r.text
    assert r.json()["active"] is True

    status = client.get("/lots/test-lot/status").json()
    rows = {s["spaceId"]: s for s in status["spaces"]}
    for sid in ROW_B:
        assert rows[sid]["state"] == "CLOSED"
        assert rows[sid]["closure"]["reason"] == "EVENT"
    assert status["counts"]["closed"] == 7
    assert status["counts"]["free"] == 1

    summary = next(lot for lot in client.get("/lots").json() if lot["lotId"] == "test-lot")[
        "summary"
    ]
    assert summary["closed"] == 7
    assert summary["total"] == 14 - 7
    assert summary["free"] == 1
    assert summary["openPercent"] == round(1 / 7 * 100)


def test_closure_beats_detection(client, admin_headers, adapters):
    detect(adapters, "B-03", SpaceState.FREE)
    assert spaces(client)["B-03"]["state"] == "FREE"
    assert create(client, admin_headers, ["B-03"]).status_code == 201
    assert spaces(client)["B-03"]["state"] == "CLOSED"
    # A newer detection still does not override the closure.
    detect(adapters, "B-03", SpaceState.FREE, at=NOW)
    assert spaces(client)["B-03"]["state"] == "CLOSED"


def test_scheduled_closure_starts_on_its_own(client, admin_headers, adapters, clock):
    detect(adapters, "A-02", SpaceState.OCCUPIED)
    starts = NOW + timedelta(days=1)
    r = create(client, admin_headers, ["A-02"], starts=starts, ends=starts + timedelta(hours=4))
    assert r.status_code == 201 and r.json()["active"] is False
    assert spaces(client)["A-02"]["state"] == "OCCUPIED"
    clock.now = starts + timedelta(minutes=1)
    assert spaces(client)["A-02"]["state"] == "CLOSED"


def test_closure_ends_on_its_own(client, admin_headers, adapters, clock):
    detect(adapters, "A-03", SpaceState.FREE)
    ends = NOW + timedelta(hours=2)
    assert create(client, admin_headers, ["A-03"], ends=ends).status_code == 201
    assert spaces(client)["A-03"]["state"] == "CLOSED"
    clock.now = ends
    assert spaces(client)["A-03"]["state"] == "FREE"
    listed = client.get(URL, headers=admin_headers).json()
    assert listed[0]["active"] is False and listed[0]["endedAt"] is None


def test_end_a_closure_early(client, admin_headers, adapters, clock):
    detect(adapters, "A-04", SpaceState.OCCUPIED)
    created = create(client, admin_headers, ["A-04"], ends=NOW + timedelta(hours=8)).json()
    clock.now = NOW + timedelta(hours=1)
    assert spaces(client)["A-04"]["state"] == "CLOSED"
    r = client.delete(f"{URL}/{created['closureId']}", headers=admin_headers)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["endedAt"] == (NOW + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    assert out["active"] is False
    assert spaces(client)["A-04"]["state"] == "OCCUPIED"
    # The record is kept.
    listed = client.get(URL, headers=admin_headers).json()
    assert [c["closureId"] for c in listed] == [created["closureId"]]
    assert listed[0]["endedAt"] == out["endedAt"]


def test_open_ended_closure(client, admin_headers, clock):
    r = create(client, admin_headers, ["A-05"], ends=None)
    assert r.status_code == 201 and r.json()["endsAt"] is None
    clock.now = NOW + timedelta(days=30)
    row = spaces(client)["A-05"]
    assert row["state"] == "CLOSED" and row["closure"]["endsAt"] is None


def test_end_before_start_is_rejected(client, admin_headers):
    for ends in (NOW - timedelta(hours=1), NOW):
        r = create(client, admin_headers, ["A-01"], starts=NOW, ends=ends)
        assert r.status_code == 422
        assert r.json() == {
            "error": "invalid_window",
            "message": "End time must be after start time",
        }
    assert client.get(URL, headers=admin_headers).json() == []


def test_closures_are_recorded(client, admin_headers, settings):
    starts = NOW + timedelta(hours=1)
    ends = NOW + timedelta(hours=3)
    create(client, admin_headers, ["A-01"], reason="MAINTENANCE", starts=NOW - timedelta(days=1))
    r = create(
        client,
        admin_headers,
        ["B-01", "B-02", "B-01"],
        reason="CONSTRUCTION",
        starts=starts,
        ends=ends,
    )
    assert r.status_code == 201
    listed = client.get(URL, headers=admin_headers).json()
    assert len(listed) == 2
    latest = listed[0]  # sorted by startsAt, newest first
    assert latest["closureId"].startswith("cl_")
    assert latest["lotId"] == "test-lot"
    assert latest["spaceIds"] == ["B-01", "B-02"]
    assert latest["reason"] == "CONSTRUCTION"
    assert latest["startsAt"] == starts.isoformat().replace("+00:00", "Z")
    assert latest["endsAt"] == ends.isoformat().replace("+00:00", "Z")
    assert latest["createdBy"] == settings.dev_admin_email
    assert latest["createdAt"] == NOW.isoformat().replace("+00:00", "Z")
    assert latest["endedAt"] is None and latest["active"] is False
    assert listed[1]["reason"] == "MAINTENANCE" and listed[1]["active"] is True


def test_unknown_or_retired_space_rejected(client, admin_headers, adapters):
    r = create(client, admin_headers, ["A-01", "Z-99"])
    assert r.status_code == 422
    assert r.json() == {"error": "unknown_space", "message": "Unknown or retired space: Z-99"}

    repo, store = adapters.repository, adapters.object_store
    layout = repo.get_published_layout("test-lot")
    for s in layout.spaces:
        s.retired = s.space_id == "A-07"
    store.put(
        layout_snapshot_key("test-lot", layout.version),
        layout.model_dump_json(by_alias=True).encode(),
        "application/json",
    )
    r = create(client, admin_headers, ["A-07"])
    assert r.status_code == 422
    assert r.json()["message"] == "Unknown or retired space: A-07"
    assert client.get(URL, headers=admin_headers).json() == []


def test_unpublished_lot_409(client, admin_headers):
    r = create(client, admin_headers, ["A-01"], lot="draft")
    assert r.status_code == 409
    assert r.json() == {
        "error": "not_published",
        "message": "Publish the lot before closing spaces",
    }
    assert client.get("/admin/lots/draft/closures", headers=admin_headers).json() == []


def test_naive_datetime_rejected(client, admin_headers):
    payload = {"spaceIds": ["A-01"], "reason": "EVENT", "startsAt": "2026-10-01T12:00:00"}
    r = client.post(URL, json=payload, headers=admin_headers)
    assert r.status_code == 422 and r.json()["error"] == "validation_error"


def test_empty_space_list_rejected(client, admin_headers):
    r = create(client, admin_headers, [])
    assert r.status_code == 422 and r.json()["error"] == "validation_error"


def test_delete_already_ended_409(client, admin_headers, clock):
    early = create(client, admin_headers, ["A-01"]).json()
    assert client.delete(f"{URL}/{early['closureId']}", headers=admin_headers).status_code == 200
    expired = create(client, admin_headers, ["A-02"], ends=NOW + timedelta(hours=1)).json()
    clock.now = NOW + timedelta(hours=1)
    for cid in (early["closureId"], expired["closureId"]):
        r = client.delete(f"{URL}/{cid}", headers=admin_headers)
        assert r.status_code == 409
        assert r.json() == {"error": "already_ended", "message": "This closure has already ended"}


def test_delete_scheduled_closure(client, admin_headers, clock):
    starts = NOW + timedelta(days=1)
    created = create(client, admin_headers, ["A-06"], starts=starts).json()
    r = client.delete(f"{URL}/{created['closureId']}", headers=admin_headers)
    assert r.status_code == 200
    clock.now = starts + timedelta(hours=1)
    assert spaces(client)["A-06"]["state"] != "CLOSED"


def test_delete_unknown_closure_404(client, admin_headers):
    r = client.delete(f"{URL}/cl_nope", headers=admin_headers)
    assert r.status_code == 404
    assert r.json() == {"error": "not_found", "message": "Closure not found"}


def test_unknown_lot_404(client, admin_headers):
    r = client.get("/admin/lots/nope/closures", headers=admin_headers)
    assert r.status_code == 404 and r.json()["message"] == "Lot not found"
    r = create(client, admin_headers, ["A-01"], lot="nope")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


@pytest.mark.parametrize(("method", "path", "kw"), CLOSURE_ROUTES)
def test_closure_routes_require_admin(client, viewer_headers, settings, method, path, kw):
    assert getattr(client, method)(path, **kw).status_code == 401
    r = getattr(client, method)(path, headers=viewer_headers, **kw)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    old = token(settings, settings.dev_admin_email, ["admin"], now=NOW - timedelta(days=1))
    r = getattr(client, method)(path, headers={"Authorization": f"Bearer {old}"}, **kw)
    assert r.status_code == 401 and r.json()["error"] == "session_expired"
