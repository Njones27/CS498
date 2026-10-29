"""Draft layout API (brief §4.1): one test per acceptance criterion, plus errors and auth."""

from __future__ import annotations

import copy
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from .conftest import NOW, token

URL = "/admin/lots/test-lot/layout/draft"
STALE = "This draft changed in another window. Reload to see the latest."

LAYOUT_ROUTES = [
    ("get", URL, {}),
    ("put", URL, {"json": {}}),
]


@pytest.mark.parametrize(("method", "path", "kw"), LAYOUT_ROUTES)
def test_layout_routes_require_admin(client, viewer_headers, settings, method, path, kw):
    assert getattr(client, method)(path, **kw).status_code == 401
    r = getattr(client, method)(path, headers=viewer_headers, **kw)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    old = token(settings, settings.dev_admin_email, ["admin"], now=NOW - timedelta(days=1))
    r = getattr(client, method)(path, headers={"Authorization": f"Bearer {old}"}, **kw)
    assert r.status_code == 401 and r.json()["error"] == "session_expired"


def get_draft(client, headers, lot="test-lot") -> dict:
    r = client.get(f"/admin/lots/{lot}/layout/draft", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def as_body(draft: dict) -> dict:
    """A GET response turned into a PUT body (what useDraftLayout sends)."""
    body = copy.deepcopy(draft)
    for key in ("lotId", "updatedAt", "updatedBy", "basedOnVersion"):
        body.pop(key, None)
    for v in body["viewpoints"]:
        v.pop("referenceImage", None)
    return body


def put(client, headers, body, lot="test-lot"):
    return client.put(f"/admin/lots/{lot}/layout/draft", json=body, headers=headers)


def space(draft: dict, space_id: str) -> dict:
    return next(s for s in draft["spaces"] if s["spaceId"] == space_id)


def view(draft: dict, view_id: str) -> dict:
    return next(v for v in draft["viewpoints"] if v["viewId"] == view_id)


NEW_SPACE = {
    "spaceId": "sp_k3x9q2ab",
    "label": "C-01",
    "type": "EV",
    "rect": {"x": 80, "y": 540, "w": 110, "h": 50},
    "retired": False,
}
C01_OUTLINE = [[0.6, 0.1], [0.7, 0.1], [0.7, 0.2], [0.6, 0.2]]


# --- GET ----------------------------------------------------------------------


def test_first_get_creates_draft_meta(client, admin_headers, adapters):
    assert adapters.repository.get_draft_meta("test-lot") is None
    d = get_draft(client, admin_headers)
    assert d["lotId"] == "test-lot"
    assert d["revision"] == 0
    assert d["basedOnVersion"] == 1
    assert d["updatedBy"] is None
    assert d["schematic"] == {"width": 1000, "height": 600}
    assert len(d["spaces"]) == 14
    assert space(d, "A-01") == {
        "spaceId": "A-01",
        "label": "A-01",
        "type": "ADA",
        "rect": {"x": 80, "y": 80, "w": 110, "h": 180},
        "retired": False,
    }
    v1 = view(d, "V1")
    assert v1["name"] == "North corner"
    assert v1["referenceImage"]["url"].startswith("/api/_test/objects/reference/test-lot/V1/")
    assert (v1["referenceImage"]["width"], v1["referenceImage"]["height"]) == (640, 360)
    assert v1["outlines"]["A-01"] == [[0.05, 0.55], [0.17, 0.55], [0.15, 0.92], [0.03, 0.92]]
    assert v1["outlineReview"] == {}
    meta = adapters.repository.get_draft_meta("test-lot")
    assert meta is not None and meta.revision == 0 and meta.based_on_version == 1
    assert get_draft(client, admin_headers)["revision"] == 0  # a second GET reuses it


def test_first_get_on_unpublished_lot(client, admin_headers):
    d = get_draft(client, admin_headers, lot="draft")
    assert d["basedOnVersion"] is None
    assert d["schematic"] == {"width": 1000, "height": 600}
    assert (d["spaces"], d["viewpoints"]) == ([], [])


def test_unknown_lot_is_404(client, admin_headers):
    r = client.get("/admin/lots/nope/layout/draft", headers=admin_headers)
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    body = {"revision": 0, "schematic": {"width": 10, "height": 10}, "spaces": [], "viewpoints": []}
    assert put(client, admin_headers, body, lot="nope").status_code == 404


# --- US-07 #7: draft survives a reload ------------------------------------------


def test_draft_survives_reload(app, client, admin_headers, settings, clock):
    body = as_body(get_draft(client, admin_headers))
    space(body, "A-03")["rect"] = {"x": 330, "y": 90, "w": 100, "h": 170}
    space(body, "A-03")["label"] = "A-3"
    space(body, "B-07")["type"] = "ADA"
    body["spaces"].append(NEW_SPACE)
    view(body, "V1")["outlines"]["sp_k3x9q2ab"] = C01_OUTLINE
    view(body, "V1")["outlineReview"]["sp_k3x9q2ab"] = {"source": "drawn", "status": "accepted"}
    body["schematic"] = {"width": 1200, "height": 650}
    clock.now = NOW + timedelta(minutes=3)

    r = put(client, admin_headers, body)
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["revision"] == 1
    assert saved["updatedBy"] == settings.dev_admin_email
    assert saved["updatedAt"].startswith("2026-10-01T12:03:00")

    # Another laptop: a new client that signs in again sees the same draft.
    laptop = TestClient(app)
    fresh = token(settings, settings.dev_admin_email, ["admin"])
    reloaded = get_draft(laptop, {"Authorization": f"Bearer {fresh}"})
    assert reloaded == saved
    assert space(reloaded, "A-03")["rect"] == {"x": 330, "y": 90, "w": 100, "h": 170}
    assert space(reloaded, "A-03")["label"] == "A-3"
    assert space(reloaded, "B-07")["type"] == "ADA"
    assert space(reloaded, "sp_k3x9q2ab") == NEW_SPACE
    assert view(reloaded, "V1")["outlines"]["sp_k3x9q2ab"] == C01_OUTLINE
    assert view(reloaded, "V1")["outlineReview"] == {
        "sp_k3x9q2ab": {"source": "drawn", "status": "accepted"}
    }
    assert reloaded["schematic"] == {"width": 1200, "height": 650}


def test_stale_revision_returns_409(client, admin_headers):
    base = as_body(get_draft(client, admin_headers))
    first = copy.deepcopy(base)
    space(first, "A-01")["label"] = "first window"
    assert put(client, admin_headers, first).status_code == 200

    second = copy.deepcopy(base)  # still revision 0
    space(second, "A-02")["label"] = "second window"
    r = put(client, admin_headers, second)
    assert r.status_code == 409
    assert r.json() == {"error": "stale_revision", "message": STALE}

    d = get_draft(client, admin_headers)  # the stale save wrote nothing
    assert d["revision"] == 1
    assert space(d, "A-01")["label"] == "first window"
    assert space(d, "A-02")["label"] == "A-02"


def test_lost_race_on_meta_write_returns_409(client, admin_headers, adapters, monkeypatch):
    body = as_body(get_draft(client, admin_headers))
    monkeypatch.setattr(
        adapters.repository, "put_draft_meta", lambda meta, expected_revision: False
    )
    r = put(client, admin_headers, body)
    assert r.status_code == 409 and r.json()["error"] == "stale_revision"


# --- US-07 #3: the driver view does not change until publish -------------------


def test_draft_edit_does_not_change_driver_view(client, admin_headers):
    before = client.get("/lots/test-lot").json()
    status_before = client.get("/lots/test-lot/status").json()
    body = as_body(get_draft(client, admin_headers))
    space(body, "A-03")["rect"] = {"x": 0, "y": 0, "w": 50, "h": 50}
    space(body, "A-04")["label"] = "Z-99"
    space(body, "A-07")["retired"] = True
    body["spaces"].append(NEW_SPACE)
    assert put(client, admin_headers, body).status_code == 200

    assert client.get("/lots/test-lot").json() == before
    assert client.get("/lots/test-lot/status").json() == status_before


# --- Draft rules: published spaces are retired, never deleted ------------------


def test_cannot_delete_published_space(client, admin_headers):
    body = as_body(get_draft(client, admin_headers))
    body["spaces"] = [s for s in body["spaces"] if s["spaceId"] not in {"A-01", "B-02"}]
    r = put(client, admin_headers, body)
    assert r.status_code == 422
    err = r.json()
    assert err["error"] == "cannot_delete_published_space"
    assert err["spaceIds"] == ["A-01", "B-02"]
    d = get_draft(client, admin_headers)  # nothing was written
    assert d["revision"] == 0 and len(d["spaces"]) == 14


def test_retiring_a_published_space_is_allowed(client, admin_headers):
    body = as_body(get_draft(client, admin_headers))
    space(body, "A-01")["retired"] = True
    assert put(client, admin_headers, body).status_code == 200
    assert space(get_draft(client, admin_headers), "A-01")["retired"] is True


def test_can_delete_unpublished_space(client, admin_headers, adapters):
    body = as_body(get_draft(client, admin_headers))
    body["spaces"].append(NEW_SPACE)
    saved = put(client, admin_headers, body).json()

    body = as_body(saved)
    body["spaces"] = [s for s in body["spaces"] if s["spaceId"] != NEW_SPACE["spaceId"]]
    r = put(client, admin_headers, body)
    assert r.status_code == 200, r.text
    assert NEW_SPACE["spaceId"] not in {s["spaceId"] for s in r.json()["spaces"]}
    assert NEW_SPACE["spaceId"] not in {
        s.space_id for s in adapters.repository.list_spaces("test-lot")
    }


def test_deleting_from_an_unpublished_lot(client, admin_headers):
    body = as_body(get_draft(client, admin_headers, lot="draft"))
    body["spaces"] = [NEW_SPACE]
    saved = put(client, admin_headers, body, lot="draft").json()
    body = as_body(saved)
    body["spaces"] = []
    r = put(client, admin_headers, body, lot="draft")
    assert r.status_code == 200 and r.json()["spaces"] == []


# --- Viewpoints -----------------------------------------------------------------


def test_put_keeps_reference_image_fields(client, admin_headers, adapters):
    before = adapters.repository.get_viewpoint("test-lot", "V1")
    assert before is not None and before.reference_image_key is not None
    draft = get_draft(client, admin_headers)
    body = as_body(draft)
    view(body, "V1")["name"] = "North pole"
    # A client that echoes (or forges) the read-only fields changes nothing.
    view(body, "V1")["referenceImage"] = {
        "url": "https://evil.example/x.jpg",
        "width": 1,
        "height": 1,
    }
    view(body, "V1")["referenceImageKey"] = "reference/test-lot/V1/forged.jpg"
    r = put(client, admin_headers, body)
    assert r.status_code == 200, r.text

    after = adapters.repository.get_viewpoint("test-lot", "V1")
    assert after.name == "North pole"
    assert after.reference_image_key == before.reference_image_key
    assert (after.image_width, after.image_height) == (before.image_width, before.image_height)
    assert view(r.json(), "V1")["referenceImage"] == view(draft, "V1")["referenceImage"]


def test_new_viewpoint_is_added(client, admin_headers):
    body = as_body(get_draft(client, admin_headers))
    body["viewpoints"].append({"viewId": "V3", "name": "Roof", "outlines": {}, "outlineReview": {}})
    r = put(client, admin_headers, body)
    assert r.status_code == 200, r.text
    v3 = view(r.json(), "V3")
    assert v3 == {
        "viewId": "V3",
        "name": "Roof",
        "referenceImage": None,
        "outlines": {},
        "outlineReview": {},
    }


def test_viewpoints_cannot_be_removed(client, admin_headers):
    body = as_body(get_draft(client, admin_headers))
    body["viewpoints"] = [v for v in body["viewpoints"] if v["viewId"] != "V2"]
    r = put(client, admin_headers, body)
    assert r.status_code == 422
    assert r.json()["error"] == "validation_error"
    assert "V2" in r.json()["message"]


# --- Malformed bodies ----------------------------------------------------------


def _three_corners(b):
    view(b, "V1")["outlines"]["A-01"] = [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]]


def _five_corners(b):
    view(b, "V1")["outlines"]["A-01"] = [[0.1, 0.1]] * 5


def _unknown_type(b):
    space(b, "A-01")["type"] = "MOTORCYCLE"


def _duplicate_space_id(b):
    b["spaces"].append({**space(b, "A-01"), "label": "copy"})


def _duplicate_view_id(b):
    b["viewpoints"].append({**view(b, "V1")})


def _bad_review_status(b):
    view(b, "V1")["outlineReview"]["A-01"] = {"source": "drawn", "status": "maybe"}


def _missing_revision(b):
    del b["revision"]


@pytest.mark.parametrize(
    "mutate",
    [
        _three_corners,
        _five_corners,
        _unknown_type,
        _duplicate_space_id,
        _duplicate_view_id,
        _bad_review_status,
        _missing_revision,
    ],
)
def test_malformed_body_is_422(client, admin_headers, mutate):
    body = as_body(get_draft(client, admin_headers))
    mutate(body)
    r = put(client, admin_headers, body)
    assert r.status_code == 422
    assert r.json()["error"] == "validation_error"
    assert get_draft(client, admin_headers)["revision"] == 0
