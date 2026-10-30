"""US-16 admin lots: one test per acceptance criterion, plus validation and admin auth."""

from __future__ import annotations

from datetime import timedelta

import pytest
from parking_api.routes.lots_admin import slugify
from parking_core.models import Closure, ClosureReason, Lot, SpaceState, SpaceStatus
from parking_seed.loader import load_lot_file, seed_lot

from .conftest import NOW, token

URL = "/admin/lots"
ROW_B = [f"B-{n:02d}" for n in range(1, 8)]

LOT_ROUTES = [
    ("get", URL, {}),
    ("post", URL, {"json": {"name": "North Lot"}}),
]


def create(client, headers, name="North Lot", location="North campus", stale=45):
    payload = {"name": name, "location": location, "staleAfterMinutes": stale}
    return client.post(URL, json=payload, headers=headers)


def admin_lots(client, headers) -> dict[str, dict]:
    r = client.get(URL, headers=headers)
    assert r.status_code == 200, r.text
    return {lot["lotId"]: lot for lot in r.json()}


def seed_north_lot(adapters) -> None:
    """A published North Lot that reuses Test Lot's space ids, so any leak would show."""
    data = {**load_lot_file("test-lot"), "lotId": "north-lot", "name": "North Lot"}
    seed_lot(adapters, data, b"ref")


# --- auth -------------------------------------------------------------------


@pytest.mark.parametrize(("method", "path", "kw"), LOT_ROUTES)
def test_admin_lot_routes_require_admin(client, viewer_headers, settings, method, path, kw):
    assert getattr(client, method)(path, **kw).status_code == 401
    r = getattr(client, method)(path, headers=viewer_headers, **kw)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    old = token(settings, settings.dev_admin_email, ["admin"], now=NOW - timedelta(days=1))
    r = getattr(client, method)(path, headers={"Authorization": f"Bearer {old}"}, **kw)
    assert r.status_code == 401 and r.json()["error"] == "session_expired"


def test_viewer_cannot_create_a_lot(client, viewer_headers, adapters):
    create(client, viewer_headers)
    assert adapters.repository.get_lot("north-lot") is None


# --- list -------------------------------------------------------------------


def test_list_includes_unpublished_lots_sorted_by_name(client, admin_headers):
    r = client.get(URL, headers=admin_headers)
    assert r.status_code == 200
    assert [lot["name"] for lot in r.json()] == ["Draft Lot", "Test Lot"]
    lots = {lot["lotId"]: lot for lot in r.json()}
    assert lots["draft"]["published"] is False and lots["draft"]["layoutVersion"] is None
    assert lots["test-lot"]["published"] is True and lots["test-lot"]["layoutVersion"] == 1
    assert set(lots["test-lot"]) == {
        "lotId",
        "name",
        "location",
        "staleAfterMinutes",
        "published",
        "layoutVersion",
        "createdAt",
    }


# --- US-16 #1 ---------------------------------------------------------------


def test_create_a_lot(client, admin_headers):
    r = create(client, admin_headers, name="  North Lot  ", location=" North campus ")
    assert r.status_code == 201, r.text
    assert r.json() == {
        "lotId": "north-lot",
        "name": "North Lot",
        "location": "North campus",
        "staleAfterMinutes": 45,
        "published": False,
        "layoutVersion": None,
        "createdAt": NOW.isoformat().replace("+00:00", "Z"),
    }
    assert admin_lots(client, admin_headers)["north-lot"]["name"] == "North Lot"

    draft = client.get("/admin/lots/north-lot/layout/draft", headers=admin_headers)
    assert draft.status_code == 200, draft.text
    assert draft.json()["spaces"] == [] and draft.json()["viewpoints"] == []
    assert draft.json()["revision"] == 0 and draft.json()["basedOnVersion"] is None


def test_new_lot_draft_can_be_saved(client, admin_headers):
    """The empty draft is a real draft: the mapping page can save into it straight away."""
    create(client, admin_headers)
    draft = client.get("/admin/lots/north-lot/layout/draft", headers=admin_headers).json()
    space = {
        "spaceId": "sp_abcd1234",
        "label": "A-01",
        "type": "STANDARD",
        "rect": {"x": 10, "y": 10, "w": 100, "h": 180},
        "retired": False,
    }
    body = {
        "lotId": "north-lot",
        "revision": draft["revision"],
        "basedOnVersion": None,
        "schematic": draft["schematic"],
        "spaces": [space],
        "viewpoints": [],
    }
    r = client.put("/admin/lots/north-lot/layout/draft", json=body, headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 1


def test_lot_id_slug_gets_a_suffix_when_taken(client, admin_headers, adapters):
    adapters.repository.put_lot(Lot(lot_id="north-lot", name="Old North", created_at=NOW))
    assert create(client, admin_headers, name="North Lot").json()["lotId"] == "north-lot-2"
    assert create(client, admin_headers, name="North-Lot!").json()["lotId"] == "north-lot-3"


def test_lot_named_new_does_not_take_the_new_lot_route(client, admin_headers):
    """`/admin/lots/new` is the New Lot page, so `new` is never a lot id."""
    assert create(client, admin_headers, name="New").json()["lotId"] == "new-2"
    assert create(client, admin_headers, name="New!").json()["lotId"] == "new-3"


def test_concurrent_create_never_overwrites_a_lot(client, admin_headers, adapters, monkeypatch):
    """Another admin's create of the same id lands after this request looked: the conditional
    create moves this lot to the next suffix and leaves the other lot, published, untouched."""
    repo = adapters.repository
    theirs = Lot(lot_id="north-lot", name="North-Lot", created_at=NOW, current_layout_version=3)
    repo.put_lot(theirs)
    monkeypatch.setattr(repo, "get_lot", lambda lot_id: None)  # every lookup raced the create
    r = create(client, admin_headers, name="North Lot")
    assert r.status_code == 201, r.text
    assert r.json()["lotId"] == "north-lot-2"
    monkeypatch.undo()
    assert repo.get_lot("north-lot") == theirs


@pytest.mark.parametrize(
    ("name", "slug"),
    [
        ("North Lot", "north-lot"),
        ("  Lot #4 (East) ", "lot-4-east"),
        ("Café Lot", "cafe-lot"),
        ("***", "lot"),
    ],
)
def test_slugify(name, slug):
    assert slugify(name) == slug


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "   "},
        {"location": "x"},
        {"name": "X", "staleAfterMinutes": 0},
        {"name": "X", "staleAfterMinutes": 1441},
        {"name": "X", "staleAfterMinutes": 2.5},
        {"name": "X", "staleAfterMinutes": "soon"},
        {"name": "N" * 121},
        {"name": "X", "location": "L" * 201},
    ],
)
def test_create_lot_validation(client, admin_headers, adapters, payload):
    before = len(adapters.repository.list_lots())
    r = client.post(URL, json=payload, headers=admin_headers)
    assert r.status_code == 422 and r.json()["error"] == "validation_error"
    assert len(adapters.repository.list_lots()) == before


def test_longest_name_and_location_are_accepted(client, admin_headers):
    r = create(client, admin_headers, name="N" * 120, location="L" * 200)
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("stale", [1, 1440])
def test_stale_after_minutes_bounds_are_inclusive(client, admin_headers, stale):
    assert create(client, admin_headers, stale=stale).status_code == 201


# --- US-16 #2 ---------------------------------------------------------------


@pytest.mark.parametrize("name", ["Test Lot", "test lot", "  TEST LOT  "])
def test_duplicate_lot_name(client, admin_headers, adapters, name):
    before = adapters.repository.list_lots()
    r = create(client, admin_headers, name=name)
    assert r.status_code == 409
    assert r.json() == {
        "error": "duplicate_lot_name",
        "message": "A lot with this name already exists",
    }
    assert adapters.repository.list_lots() == before


# --- US-16 #4 ---------------------------------------------------------------


def test_unpublished_lot_stays_hidden(client, admin_headers):
    assert create(client, admin_headers).status_code == 201
    driver_lots = [lot["lotId"] for lot in client.get("/lots").json()]
    assert "north-lot" not in driver_lots and "draft" not in driver_lots
    assert "test-lot" in driver_lots
    assert client.get("/lots/north-lot").status_code == 404
    assert client.get("/lots/north-lot/status").status_code == 404


# --- US-16 #6 ---------------------------------------------------------------


def test_lots_stay_separate(client, adapters):
    seed_north_lot(adapters)
    repo = adapters.repository
    for lot_id in ("test-lot", "north-lot"):
        repo.update_status_if_newer(
            SpaceStatus(
                lot_id=lot_id,
                space_id="B-01",
                state=SpaceState.FREE,
                observed_at=NOW - timedelta(minutes=5),
                source_image_id=f"img-{lot_id}",
            )
        )
    repo.put_closure(
        Closure(
            closure_id="cl_rowb",
            lot_id="test-lot",
            space_ids=ROW_B,
            reason=ClosureReason.EVENT,
            starts_at=NOW - timedelta(hours=1),
            ends_at=NOW + timedelta(hours=8),
            created_by="admin@example.edu",
            created_at=NOW - timedelta(hours=1),
        )
    )

    test_lot = client.get("/lots/test-lot/status").json()
    assert test_lot["counts"]["closed"] == 7

    north = client.get("/lots/north-lot/status").json()
    assert north["counts"]["closed"] == 0
    assert north["counts"]["free"] == 1
    assert all(s["state"] != "CLOSED" and s["closure"] is None for s in north["spaces"])

    summaries = {lot["lotId"]: lot["summary"] for lot in client.get("/lots").json()}
    assert summaries["north-lot"]["closed"] == 0
    assert summaries["north-lot"]["total"] == 14
    assert summaries["test-lot"]["total"] == 14 - 7
