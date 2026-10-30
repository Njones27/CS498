"""A brand-new lot end to end (US-16 #4-#6, US-15, US-09): created through the admin API,
mapped, published, then seen by drivers and kept apart from Test Lot.

North Lot reuses Test Lot's space ids (A-01..A-03) on purpose, so any lookup that forgets
the lot id shows up as a leak between the two."""

from __future__ import annotations

from datetime import timedelta

import pytest

from .conftest import NOW
from .integration_helpers import (
    CLOSED,
    FREE,
    OCCUPIED,
    UNKNOWN,
    at,
    close,
    create_lot,
    driver_lots,
    get_draft,
    publish,
    publish_ok,
    quad,
    request_slot,
    run_worker,
    save_draft,
    scripted_scorer,
    snapshot,
    space,
    states,
    status,
    upload_photo,
    upload_reference,
)

NORTH_SPACES = ["A-01", "A-02", "A-03"]


def admin_lots(client, headers) -> dict[str, dict]:
    r = client.get("/admin/lots", headers=headers)
    assert r.status_code == 200, r.text
    return {lot["lotId"]: lot for lot in r.json()}


@pytest.fixture
def north(client, admin_headers) -> str:
    """North Lot, mapped and ready to publish but not published: three spaces, viewpoint V1
    "Roof" with a reference photo, A-01 and A-02 outlined and A-03 not."""
    lot = create_lot(client, admin_headers, "North Lot", location="North campus", stale=45)
    lot_id = lot["lotId"]
    assert lot["published"] is False and lot["layoutVersion"] is None
    draft = get_draft(client, admin_headers, lot_id)
    assert (draft["basedOnVersion"], draft["spaces"], draft["viewpoints"]) == (None, [], [])
    save_draft(
        client,
        admin_headers,
        lot_id,
        spaces=[space(sid, i) for i, sid in enumerate(NORTH_SPACES)],
        viewpoints=[
            {"viewId": "V1", "name": "Roof", "outlines": {"A-01": quad(1), "A-02": quad(2)}}
        ],
    )
    upload_reference(client, admin_headers, lot_id, "V1", b"north-roof-reference")
    r = client.post(f"/admin/lots/{lot_id}/layout/draft/validate", headers=admin_headers)
    assert r.status_code == 200, r.text
    report = r.json()
    assert report["ok"] is True
    assert [w["code"] for w in report["warnings"]] == ["unmapped_spaces"]
    return lot_id


@pytest.fixture
def published_north(client, admin_headers, north) -> str:
    assert publish_ok(client, admin_headers, north)["version"] == 1
    return north


def test_new_lot_appears_for_drivers_once_published(client, admin_headers, north):
    # US-16 #4: hidden from drivers until its first publish.
    assert north not in driver_lots(client)
    assert client.get(f"/lots/{north}").status_code == 404
    assert client.get(f"/lots/{north}/status").status_code == 404
    assert admin_lots(client, admin_headers)[north]["published"] is False
    test_lot_before = driver_lots(client)["test-lot"]

    publish_ok(client, admin_headers, north)

    # US-16 #5: it appears with its own bar, every space unknown until a photo covers it.
    admin = admin_lots(client, admin_headers)[north]
    assert (admin["published"], admin["layoutVersion"]) == (True, 1)
    listed = driver_lots(client)
    assert list(listed) == ["north-lot", "test-lot"]  # sorted by name, US-15 #1
    item = listed[north]
    assert (item["name"], item["location"], item["staleAfterMinutes"]) == (
        "North Lot",
        "North campus",
        45,
    )
    assert item["layoutVersion"] == 1
    assert item["summary"] == {
        "free": 0,
        "occupied": 0,
        "unknown": 3,
        "closed": 0,
        "total": 3,
        "openPercent": None,
        "isStale": False,
        "hasRecentData": False,
    }
    detail = client.get(f"/lots/{north}").json()
    assert [s["spaceId"] for s in detail["layout"]["spaces"]] == NORTH_SPACES
    assert detail["viewpoints"] == [{"viewId": "V1", "name": "Roof"}]
    st = status(client, north)
    assert (st["noObservations"], st["layoutVersion"], st["processing"]) == (True, 1, False)
    assert st["lastObservedAt"] is None
    assert {s["spaceId"]: s["state"] for s in st["spaces"]} == dict.fromkeys(NORTH_SPACES, UNKNOWN)
    # Publishing North Lot leaves Test Lot as it was.
    assert listed["test-lot"] == test_lot_before


def test_new_lot_photo_updates_only_its_own_map(
    client, admin_headers, adapters, settings, clock, published_north
):
    captured = NOW - timedelta(minutes=5)
    image_id = upload_photo(client, admin_headers, published_north, "V1", b"north-1", captured)
    assert status(client, published_north)["processing"] is True

    scorer = scripted_scorer({"A-01": OCCUPIED, "A-02": FREE})
    assert run_worker(adapters, settings, scorer, clock).outcome == "completed"

    # US-09 #3 / US-16 #5: the unmapped A-03 stays UNKNOWN.
    st = status(client, published_north)
    got = {s["spaceId"]: s["state"] for s in st["spaces"]}
    assert got == {"A-01": OCCUPIED, "A-02": FREE, "A-03": UNKNOWN}
    assert at(st["lastObservedAt"]) == captured
    assert st["processing"] is False
    assert snapshot(client, admin_headers, image_id)["layoutVersion"] == 1

    # US-15 #3, #7: the list's counts are the map's counts.
    summary = driver_lots(client)[published_north]["summary"]
    assert (summary["free"], summary["total"], summary["openPercent"]) == (1, 3, 33)
    assert summary["hasRecentData"] is True
    assert {k: summary[k] for k in st["counts"]} == st["counts"]

    # US-16 #6: Test Lot's A-01/A-02 are untouched by North Lot's photo.
    test_lot = states(client, "test-lot")
    assert test_lot["A-01"] == (UNKNOWN, None) and test_lot["A-02"] == (UNKNOWN, None)


def test_empty_new_lot_cannot_be_published(client, admin_headers):
    lot_id = create_lot(client, admin_headers, "Empty Lot")["lotId"]
    r = publish(client, admin_headers, lot_id)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["error"] == "validation_failed"
    assert [e["code"] for e in body["report"]["errors"]] == ["no_active_spaces"]
    assert lot_id not in driver_lots(client)
    assert client.get(f"/lots/{lot_id}/status").status_code == 404
    r = client.get(f"/admin/lots/{lot_id}/layout/versions", headers=admin_headers)
    assert r.status_code == 200 and r.json() == []


def test_new_lot_without_viewpoints_publishes_but_takes_no_photos(client, admin_headers):
    lot_id = create_lot(client, admin_headers, "West Lot")["lotId"]
    save_draft(
        client, admin_headers, lot_id, spaces=[space("W-01", 0), space("W-02", 1)], viewpoints=[]
    )
    r = publish(client, admin_headers, lot_id)
    assert r.status_code == 201, r.text
    assert {s: v[0] for s, v in states(client, lot_id).items()} == {
        "W-01": UNKNOWN,
        "W-02": UNKNOWN,
    }
    r = request_slot(client, admin_headers, lot_id, "V1", b"west", NOW - timedelta(minutes=5))
    assert r.status_code == 422 and r.json()["error"] == "unknown_viewpoint"
    r = client.get(f"/admin/snapshots?lotId={lot_id}", headers=admin_headers)
    assert r.status_code == 200 and r.json() == []


def test_closures_need_the_first_publish(client, admin_headers, north):
    r = close(client, admin_headers, north, ["A-03"], NOW - timedelta(minutes=1))
    assert r.status_code == 409 and r.json()["error"] == "not_published"
    assert client.get(f"/admin/lots/{north}/closures", headers=admin_headers).json() == []

    publish_ok(client, admin_headers, north)
    r = close(client, admin_headers, north, ["A-03"], NOW - timedelta(minutes=1))
    assert r.status_code == 201, r.text
    st = status(client, north)
    assert {s["spaceId"]: s["state"] for s in st["spaces"]}["A-03"] == CLOSED
    summary = driver_lots(client)[north]["summary"]
    assert (summary["closed"], summary["total"]) == (1, 2)  # closed spaces leave the total
    # US-16 #6: North Lot's A-03 is not Test Lot's A-03.
    assert driver_lots(client)["test-lot"]["summary"]["closed"] == 0
    assert states(client, "test-lot")["A-03"][0] == UNKNOWN


def test_admin_reads_are_scoped_to_the_picked_lot(
    client, admin_headers, adapters, settings, clock, published_north
):
    """US-16 #3 (backend): snapshots, closures, drafts and versions are all per lot."""
    north_img = upload_photo(
        client, admin_headers, published_north, "V1", b"north-p", NOW - timedelta(minutes=5)
    )
    run_worker(adapters, settings, scripted_scorer({}), clock)
    test_img = upload_photo(
        client, admin_headers, "test-lot", "V1", b"test-p", NOW - timedelta(minutes=6)
    )
    run_worker(adapters, settings, scripted_scorer({}), clock)
    assert close(client, admin_headers, published_north, ["A-01"], NOW).status_code == 201
    assert close(client, admin_headers, "test-lot", ["B-01", "B-02"], NOW).status_code == 201

    for lot_id, image_id, closed in (
        (published_north, north_img, ["A-01"]),
        ("test-lot", test_img, ["B-01", "B-02"]),
    ):
        snaps = client.get(f"/admin/snapshots?lotId={lot_id}", headers=admin_headers).json()
        assert [(s["imageId"], s["lotId"]) for s in snaps] == [(image_id, lot_id)]
        closures = client.get(f"/admin/lots/{lot_id}/closures", headers=admin_headers).json()
        assert [c["spaceIds"] for c in closures] == [closed]
        assert all(c["lotId"] == lot_id for c in closures)

    north_draft = get_draft(client, admin_headers, published_north)
    test_draft = get_draft(client, admin_headers, "test-lot")
    assert [s["spaceId"] for s in north_draft["spaces"]] == NORTH_SPACES
    assert len(test_draft["spaces"]) == 14
    assert [v["name"] for v in north_draft["viewpoints"]] == ["Roof"]
    north_versions = client.get(
        f"/admin/lots/{published_north}/layout/versions", headers=admin_headers
    ).json()
    assert [v["version"] for v in north_versions] == [1]

    # V2 exists only in Test Lot, so North Lot can't take a photo tagged with it.
    r = request_slot(
        client, admin_headers, published_north, "V2", b"north-v2", NOW - timedelta(minutes=1)
    )
    assert r.status_code == 422 and r.json()["error"] == "unknown_viewpoint"


def test_each_lot_uses_its_own_allowed_data_age(
    client, admin_headers, adapters, settings, clock, published_north
):
    """US-15 #4 / US-02 per lot: North Lot allows 45 minutes, Test Lot 30."""
    old = NOW - timedelta(minutes=40)
    upload_photo(client, admin_headers, published_north, "V1", b"north-old", old)
    run_worker(adapters, settings, scripted_scorer({}), clock)
    upload_photo(client, admin_headers, "test-lot", "V1", b"test-old", old)
    run_worker(adapters, settings, scripted_scorer({}), clock)

    north_st, test_st = status(client, published_north), status(client, "test-lot")
    assert north_st["isStale"] is False
    assert not any(s["stale"] for s in north_st["spaces"] if s["observedAt"])
    assert test_st["isStale"] is True
    listed = driver_lots(client)
    assert listed[published_north]["summary"]["isStale"] is False
    assert listed[published_north]["summary"]["hasRecentData"] is True
    assert listed["test-lot"]["summary"]["isStale"] is True
    assert listed["test-lot"]["summary"]["hasRecentData"] is False
