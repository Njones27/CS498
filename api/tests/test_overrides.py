"""Admin state overrides, and viewpoints that complement each other (the server's truth)."""

from __future__ import annotations

from datetime import timedelta

from .conftest import NOW
from .integration_helpers import (
    FREE,
    OCCUPIED,
    UNKNOWN,
    run_worker,
    scripted_scorer,
    status,
    upload_photo,
)

URL = "/admin/lots/test-lot/overrides"


def body(space_ids, state="OCCUPIED", **kw):
    return {"spaceIds": space_ids, "state": state, "startsAt": NOW.isoformat(), **kw}


def rows(client) -> dict[str, dict]:
    return {s["spaceId"]: s for s in status(client, "test-lot")["spaces"]}


def test_override_sets_the_state_drivers_see(client, admin_headers, settings):
    r = client.post(URL, json=body(["B-01"], note=" event staff "), headers=admin_headers)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["state"] == "OCCUPIED" and out["status"] == "ACTIVE" and out["active"] is True
    assert out["note"] == "event staff" and out["createdBy"] == settings.dev_admin_email

    b01 = rows(client)["B-01"]
    assert b01["state"] == OCCUPIED and b01["source"] == "admin" and b01["stale"] is False
    assert b01["override"] == {"state": "OCCUPIED", "endsAt": None, "note": "event staff"}
    listed = client.get(URL, headers=admin_headers).json()
    assert [o["overrideId"] for o in listed] == [out["overrideId"]]


def test_ending_an_override_hands_back_to_the_cameras(client, admin_headers, clock):
    oid = client.post(URL, json=body(["B-01"]), headers=admin_headers).json()["overrideId"]
    clock.now = NOW + timedelta(minutes=1)
    r = client.delete(f"{URL}/{oid}", headers=admin_headers)
    assert r.status_code == 200 and r.json()["status"] == "ENDED"
    assert r.json()["endedAt"] is not None
    assert rows(client)["B-01"]["source"] != "admin"
    again = client.delete(f"{URL}/{oid}", headers=admin_headers)
    assert again.status_code == 409 and again.json()["error"] == "already_ended"


def test_override_until_a_time(client, admin_headers, clock):
    ends = NOW + timedelta(hours=1)
    client.post(URL, json=body(["B-01"], "FREE", endsAt=ends.isoformat()), headers=admin_headers)
    assert rows(client)["B-01"]["state"] == FREE
    clock.now = ends + timedelta(seconds=1)
    assert rows(client)["B-01"]["source"] != "admin"
    assert client.get(URL, headers=admin_headers).json()[0]["status"] == "ENDED"


def test_closure_wins_over_an_override(client, admin_headers):
    client.post(URL, json=body(["B-01"]), headers=admin_headers)
    client.post(
        "/admin/lots/test-lot/closures",
        json={"spaceIds": ["B-01"], "reason": "EVENT", "startsAt": NOW.isoformat()},
        headers=admin_headers,
    )
    b01 = rows(client)["B-01"]
    assert b01["state"] == "CLOSED" and b01["source"] == "closure" and b01["override"] is None


def test_override_errors(client, admin_headers):
    r = client.post(URL, json=body(["NOPE"]), headers=admin_headers)
    assert r.status_code == 422 and r.json() == {
        "error": "unknown_space",
        "message": "Unknown or retired space: NOPE",
    }
    bad = body(["B-01"], endsAt=(NOW - timedelta(minutes=1)).isoformat())
    r = client.post(URL, json=bad, headers=admin_headers)
    assert r.status_code == 422 and r.json()["message"] == "End time must be after start time"
    r = client.post(URL, json=body(["B-01"], state="CLOSED"), headers=admin_headers)
    assert r.status_code == 422 and r.json()["error"] == "validation_error"
    r = client.post("/admin/lots/draft/overrides", json=body(["B-01"]), headers=admin_headers)
    assert r.status_code == 409 and r.json()["error"] == "not_published"
    assert client.get("/admin/lots/nope/overrides", headers=admin_headers).status_code == 404
    assert client.delete(f"{URL}/ov_missing", headers=admin_headers).status_code == 404


def test_viewpoints_complement_instead_of_cancelling(
    client, admin_headers, adapters, settings, clock
):
    """B-01 is in V1 and V2. V1 sees it Occupied; a later V2 photo sees it badly (Unknown).
    Drivers keep Occupied; spaces only one view sees take that view's reading."""
    upload_photo(client, admin_headers, "test-lot", "V1", b"v1", NOW - timedelta(minutes=6))
    run_worker(adapters, settings, scripted_scorer({"B-01": OCCUPIED}), clock)
    upload_photo(client, admin_headers, "test-lot", "V2", b"v2", NOW - timedelta(minutes=1))
    run_worker(adapters, settings, scripted_scorer({"B-01": UNKNOWN}), clock)

    b01 = rows(client)["B-01"]
    assert b01["state"] == OCCUPIED and b01["views"] == ["V1"] and b01["source"] == "camera"
    readings = {
        (s.view_id, s.state.value)
        for s in adapters.repository.get_statuses("test-lot")
        if s.space_id == "B-01"
    }
    assert readings == {("V1", OCCUPIED), ("V2", UNKNOWN)}  # both kept, neither overwritten


def test_views_disagreeing_at_the_same_moment_resolve_to_occupied(
    client, admin_headers, adapters, settings, clock
):
    upload_photo(client, admin_headers, "test-lot", "V1", b"v1", NOW - timedelta(minutes=4))
    run_worker(adapters, settings, scripted_scorer({"B-01": OCCUPIED}), clock)
    upload_photo(client, admin_headers, "test-lot", "V2", b"v2", NOW - timedelta(minutes=1))
    run_worker(adapters, settings, scripted_scorer({"B-01": FREE}), clock)
    assert rows(client)["B-01"]["state"] == OCCUPIED


def test_the_server_clock_starts_an_override(client, admin_headers, clock):
    # No startsAt: it starts now by the server's clock, whatever the admin's clock says.
    r = client.post(URL, json={"spaceIds": ["B-01"], "state": "FREE"}, headers=admin_headers)
    assert r.status_code == 201 and r.json()["status"] == "ACTIVE"
    assert r.json()["startsAt"].startswith(NOW.isoformat()[:19])
    # A start the admin's clock put a few minutes ahead does not delay it.
    ahead = body(["B-02"])
    r = client.post(URL, json=ahead, headers=admin_headers)
    assert r.json()["status"] == "ACTIVE"
    # An end already past is refused, not stored as an override that never applied.
    past = {
        "spaceIds": ["B-01"],
        "state": "FREE",
        "endsAt": (NOW - timedelta(minutes=1)).isoformat(),
    }
    r = client.post(URL, json=past, headers=admin_headers)
    assert r.status_code == 422 and r.json()["error"] == "invalid_window"


def test_a_scheduled_override_waits_for_its_start(client, admin_headers, clock):
    later = NOW + timedelta(hours=2)
    r = client.post(URL, json=body(["B-01"], startsAt=later.isoformat()), headers=admin_headers)
    assert r.json()["status"] == "SCHEDULED"
    assert rows(client)["B-01"]["source"] != "admin"
    clock.now = later
    assert rows(client)["B-01"]["source"] == "admin"
