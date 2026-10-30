"""Layout API (brief §4.1, §4.3): the draft, validate, publish, versions and restore. One test
per acceptance criterion, plus errors and auth."""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from parking_worker.aligners import build_aligner
from parking_worker.handler import process_message
from parking_worker.scorers import build_scorer

from .conftest import NOW, token

URL = "/admin/lots/test-lot/layout/draft"
LAYOUT = "/admin/lots/test-lot/layout"
STALE = "This draft changed in another window. Reload to see the latest."

LAYOUT_ROUTES = [
    ("get", URL, {}),
    ("put", URL, {"json": {}}),
    ("post", f"{URL}/validate", {}),
    ("post", f"{LAYOUT}/publish", {"json": {"revision": 0}}),
    ("get", f"{LAYOUT}/versions", {}),
    ("post", f"{LAYOUT}/versions/1/restore", {}),
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


# A save that loses the race writes nothing, so a publish that won it can't include the
# items of a save that reported 409.
def test_lost_race_on_meta_write_returns_409(client, admin_headers, adapters, monkeypatch):
    body = as_body(get_draft(client, admin_headers))
    space(body, "A-01")["label"] = "lost"
    view(body, "V1")["outlines"].pop("A-01")
    monkeypatch.setattr(
        adapters.repository, "put_draft_meta", lambda meta, expected_revision: False
    )
    r = put(client, admin_headers, body)
    assert r.status_code == 409 and r.json()["error"] == "stale_revision"
    d = get_draft(client, admin_headers)
    assert space(d, "A-01")["label"] == "A-01"
    assert "A-01" in view(d, "V1")["outlines"]


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


# --- Validate, publish, versions, restore (brief §4.3) ---------------------------


def validate(client, headers, lot="test-lot") -> dict:
    r = client.post(f"/admin/lots/{lot}/layout/draft/validate", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def publish(client, headers, revision: int | None = None, lot="test-lot"):
    if revision is None:
        revision = get_draft(client, headers, lot)["revision"]
    return client.post(
        f"/admin/lots/{lot}/layout/publish", json={"revision": revision}, headers=headers
    )


def publish_ok(client, headers, lot="test-lot") -> dict:
    r = publish(client, headers, lot=lot)
    assert r.status_code == 201, r.text
    return r.json()


def edit(client, headers, change, lot="test-lot") -> dict:
    """Load the draft, apply `change` to the PUT body, save it."""
    body = as_body(get_draft(client, headers, lot))
    change(body)
    r = put(client, headers, body, lot=lot)
    assert r.status_code == 200, r.text
    return r.json()


def upload_photo(client, headers, n: int, view_id: str = "V1") -> str:
    """A queued photo of test-lot (the upload flow from test_api), returning its image id."""
    data = f"photo-{n}".encode()
    slot = client.post(
        "/admin/uploads",
        json={
            "lotId": "test-lot",
            "viewId": view_id,
            "captureTime": (NOW - timedelta(minutes=5) + timedelta(seconds=n)).isoformat(),
            "sha256": hashlib.sha256(data).hexdigest(),
            "contentType": "image/jpeg",
            "sizeBytes": len(data),
        },
        headers=headers,
    )
    assert slot.status_code == 201, slot.text
    url = slot.json()["uploadUrl"].removeprefix("/api")
    assert client.put(url, content=data, headers={"content-type": "image/jpeg"}).status_code == 204
    image_id = slot.json()["imageId"]
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=headers)
    assert r.status_code == 200, r.text
    return image_id


def run_worker(adapters, settings, scorer=None):
    """Process the next queued job with the real worker handler (stub scorer)."""
    messages = adapters.queue.receive(max_messages=1, wait_seconds=0)
    assert messages, "no queued job"
    return process_message(
        messages[0],
        adapters,
        build_aligner(settings, adapters),
        scorer or build_scorer(settings),
        settings.cutoffs,
    )


def add_new_space(body, outline: bool = True) -> None:
    body["spaces"].append(NEW_SPACE)
    if outline:
        view(body, "V1")["outlines"][NEW_SPACE["spaceId"]] = C01_OUTLINE


def test_seeded_draft_is_valid(client, admin_headers):
    report = validate(client, admin_headers)
    assert report == {
        "ok": True,
        "errors": [],
        "warnings": [],
        "comparedWith": 1,
        "diff": {"added": [], "retired": [], "changed": []},
    }


# US-09 #1: duplicate labels, an out-of-bounds polygon and unmapped spaces are listed as
# errors (x) and warnings (!), as in Sketch 6.
def test_validate_lists_problems(client, admin_headers):
    def change(body):
        space(body, "B-05")["label"] = "B-04"
        view(body, "V2")["outlines"]["B-06"] = [[0.9, 0.1], [1.2, 0.1], [1.2, 0.3], [0.9, 0.3]]
        add_new_space(body, outline=False)
        for sid in ("A-04", "A-05"):
            del view(body, "V1")["outlines"][sid]

    edit(client, admin_headers, change)
    report = validate(client, admin_headers)
    assert report["ok"] is False
    assert report["comparedWith"] == 1
    assert report["errors"] == [
        {
            "code": "duplicate_label",
            "message": "Two spaces share the label B-04",
            "spaceIds": ["B-04", "B-05"],
            "viewId": None,
        },
        {
            "code": "polygon_outside_photo",
            "message": "B-06 polygon is outside the V2 photo",
            "spaceIds": ["B-06"],
            "viewId": "V2",
        },
    ]
    assert report["warnings"] == [
        {
            "code": "unmapped_spaces",
            "message": "3 spaces have no polygon in any view: they will show UNKNOWN",
            "spaceIds": ["A-04", "A-05", "sp_k3x9q2ab"],
            "viewId": None,
        }
    ]
    assert report["diff"] == {
        "added": ["sp_k3x9q2ab"],
        "retired": [],
        "changed": ["A-04", "A-05", "B-05", "B-06"],
    }


def test_validate_unknown_lot_is_404(client, admin_headers):
    r = client.post("/admin/lots/nope/layout/draft/validate", headers=admin_headers)
    assert r.status_code == 404


# US-09 #2: publish is refused while the draft has errors (the UI also disables the button).
def test_errors_block_publishing(client, admin_headers):
    edit(client, admin_headers, lambda b: space(b, "A-02").update(label="A-01"))
    r = publish(client, admin_headers)
    assert r.status_code == 409
    err = r.json()
    assert err["error"] == "validation_failed"
    assert err["report"]["ok"] is False
    assert [i["code"] for i in err["report"]["errors"]] == ["duplicate_label"]
    assert client.get("/lots/test-lot").json()["layout"]["version"] == 1
    assert len(client.get(f"{LAYOUT}/versions", headers=admin_headers).json()) == 1


# US-09 #3: a draft with only warnings publishes, and its unmapped spaces show UNKNOWN.
def test_warnings_do_not_block(client, admin_headers):
    edit(client, admin_headers, lambda b: add_new_space(b, outline=False))
    report = validate(client, admin_headers)
    assert report["ok"] and [w["code"] for w in report["warnings"]] == ["unmapped_spaces"]
    assert publish(client, admin_headers).status_code == 201

    status = client.get("/lots/test-lot/status").json()
    assert status["layoutVersion"] == 2
    new = next(s for s in status["spaces"] if s["spaceId"] == NEW_SPACE["spaceId"])
    assert new["state"] == "UNKNOWN"


def test_publish_stale_revision(client, admin_headers):
    edit(client, admin_headers, lambda b: None)  # revision 1
    r = publish(client, admin_headers, revision=0)
    assert r.status_code == 409 and r.json() == {"error": "stale_revision", "message": STALE}
    assert client.get("/lots/test-lot").json()["layout"]["version"] == 1


def test_publish_unknown_lot_is_404(client, admin_headers):
    assert publish(client, admin_headers, revision=0, lot="nope").status_code == 404


# US-09 #4: from v3, Publish makes v4 with the publisher and time; the lot points at v4, and a
# photo queued after the publish is processed with v4 (and the scorer's model version).
def test_publish_creates_new_version(client, admin_headers, adapters, settings, clock):
    publish_ok(client, admin_headers)
    publish_ok(client, admin_headers)
    assert client.get("/lots/test-lot").json()["layout"]["version"] == 3

    edit(client, admin_headers, add_new_space)
    clock.now = NOW + timedelta(minutes=10)
    v4 = publish_ok(client, admin_headers)
    assert v4 == {
        "version": 4,
        "publishedBy": settings.dev_admin_email,
        "publishedAt": "2026-10-01T12:10:00Z",
    }
    lot = client.get("/lots/test-lot").json()
    assert lot["layout"]["version"] == 4
    assert NEW_SPACE["spaceId"] in {s["spaceId"] for s in lot["layout"]["spaces"]}
    draft = get_draft(client, admin_headers)
    assert draft["basedOnVersion"] == 4

    image_id = upload_photo(client, admin_headers, 1)
    assert run_worker(adapters, settings).outcome == "completed"
    snap = client.get(f"/admin/snapshots/{image_id}", headers=admin_headers).json()
    assert (snap["layoutVersion"], snap["modelVersion"]) == (4, "stub-0")
    observed = {o.space_id for o in adapters.repository.list_observations(image_id)}
    assert NEW_SPACE["spaceId"] in observed


def test_publish_moves_the_draft_revision(client, admin_headers):
    """Publishing claims the draft's revision, so a save from before the publish is stale."""
    before = as_body(get_draft(client, admin_headers))
    publish_ok(client, admin_headers)
    assert get_draft(client, admin_headers)["revision"] == before["revision"] + 1
    assert put(client, admin_headers, before).status_code == 409


class PublishMidway:
    """The stub scorer, but an admin publishes while the photo is being scored."""

    def __init__(self, inner, on_score) -> None:
        self.inner, self.on_score = inner, on_score
        self.model_version = inner.model_version

    @property
    def last_detections(self):
        return self.inner.last_detections

    def score(self, image, outlines):
        self.on_score()
        return self.inner.score(image, outlines)


# US-09 #5: a photo still processing when v4 is published keeps v3, and its results only
# cover spaces that existed in v3.
def test_photo_in_progress_keeps_its_version(client, admin_headers, adapters, settings):
    publish_ok(client, admin_headers)
    publish_ok(client, admin_headers)  # v3
    edit(client, admin_headers, add_new_space)
    image_id = upload_photo(client, admin_headers, 1)

    published = []
    scorer = PublishMidway(
        build_scorer(settings), lambda: published.append(publish_ok(client, admin_headers))
    )
    assert run_worker(adapters, settings, scorer).outcome == "completed"
    assert [p["version"] for p in published] == [4]

    snap = client.get(f"/admin/snapshots/{image_id}", headers=admin_headers).json()
    assert snap["layoutVersion"] == 3
    observed = {o.space_id for o in adapters.repository.list_observations(image_id)}
    v3_outlined = set(adapters.repository.get_viewpoint("test-lot", "V1").outlines) - {
        NEW_SPACE["spaceId"]
    }
    assert observed == v3_outlined


# US-09 #6: versions are listed newest first, with who published each and when.
def test_version_history(client, admin_headers, settings, clock):
    other = {"Authorization": f"Bearer {token(settings, 'kevin@example.edu', ['admin'])}"}
    clock.now = NOW + timedelta(hours=1)
    publish_ok(client, admin_headers)
    clock.now = NOW + timedelta(hours=2)
    publish_ok(client, other)
    r = client.get(f"{LAYOUT}/versions", headers=admin_headers)
    assert r.status_code == 200
    rows = r.json()
    assert [(v["version"], v["publishedBy"]) for v in rows] == [
        (3, "kevin@example.edu"),
        (2, settings.dev_admin_email),
        (1, "seed"),
    ]
    assert rows[0]["publishedAt"] == "2026-10-01T14:00:00Z"
    assert set(rows[0]) == {"version", "publishedBy", "publishedAt"}


def test_versions_unknown_lot_is_404(client, admin_headers):
    assert client.get("/admin/lots/nope/layout/versions", headers=admin_headers).status_code == 404


def test_versions_of_unpublished_lot(client, admin_headers):
    r = client.get("/admin/lots/draft/layout/versions", headers=admin_headers)
    assert r.status_code == 200 and r.json() == []


# US-09 #7: Restore v3 then publish creates v5 with v3's contents; v4 stays unchanged.
def test_restore_then_publish(client, admin_headers, adapters):
    publish_ok(client, admin_headers)  # v2
    edit(client, admin_headers, lambda b: space(b, "A-03").update(label="A-3"))
    publish_ok(client, admin_headers)  # v3
    v3 = client.get("/lots/test-lot").json()["layout"]

    def mistake(body):
        space(body, "A-03")["label"] = "WRONG"
        space(body, "B-01")["retired"] = True
        add_new_space(body)

    edit(client, admin_headers, mistake)
    publish_ok(client, admin_headers)  # v4
    v4 = client.get("/lots/test-lot").json()["layout"]
    v4_snapshot = adapters.object_store.get("layouts/test-lot/v4.json")

    r = client.post(f"{LAYOUT}/versions/3/restore", headers=admin_headers)
    assert r.status_code == 200, r.text
    restored = r.json()
    assert restored["basedOnVersion"] == 3
    assert restored == get_draft(client, admin_headers)
    assert space(restored, "A-03")["label"] == "A-3"
    assert space(restored, "B-01")["retired"] is False
    # v4 published sp_k3x9q2ab, which v3 lacks: it stays in the draft as retired.
    assert space(restored, NEW_SPACE["spaceId"])["retired"] is True
    assert NEW_SPACE["spaceId"] not in view(restored, "V1")["outlines"]
    # The driver view is still v4 until the restored draft is published.
    assert client.get("/lots/test-lot").json()["layout"] == v4

    assert publish_ok(client, admin_headers)["version"] == 5
    v5 = client.get("/lots/test-lot").json()["layout"]
    assert {**v5, "version": 3} == v3
    assert adapters.object_store.get("layouts/test-lot/v4.json") == v4_snapshot
    versions = client.get(f"{LAYOUT}/versions", headers=admin_headers).json()
    assert [v["version"] for v in versions] == [5, 4, 3, 2, 1]


def test_restored_draft_can_be_saved(client, admin_headers):
    """The retired space a restore keeps is in the draft, so the next save isn't refused as
    deleting a published space."""
    edit(client, admin_headers, add_new_space)
    publish_ok(client, admin_headers)  # v2
    restored = client.post(f"{LAYOUT}/versions/1/restore", headers=admin_headers).json()
    assert put(client, admin_headers, as_body(restored)).status_code == 200


def test_restore_drops_never_published_spaces(client, admin_headers):
    edit(client, admin_headers, add_new_space)
    restored = client.post(f"{LAYOUT}/versions/1/restore", headers=admin_headers).json()
    assert NEW_SPACE["spaceId"] not in {s["spaceId"] for s in restored["spaces"]}
    assert len(restored["spaces"]) == 14


def test_restore_unknown_version_is_404(client, admin_headers):
    r = client.post(f"{LAYOUT}/versions/9/restore", headers=admin_headers)
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    r = client.post("/admin/lots/nope/layout/versions/1/restore", headers=admin_headers)
    assert r.status_code == 404


# US-07 #3 (after publish): the edits reach drivers once published.
def test_publish_updates_driver_view(client, admin_headers):
    edit(client, admin_headers, lambda b: space(b, "A-04").update(label="Z-99"))
    assert {s["label"] for s in client.get("/lots/test-lot").json()["layout"]["spaces"]} >= {"A-04"}
    publish_ok(client, admin_headers)
    labels = {
        s["spaceId"]: s["label"] for s in client.get("/lots/test-lot").json()["layout"]["spaces"]
    }
    assert labels["A-04"] == "Z-99"


# US-07 #6: a retired space disappears from the driver view after publish, and its past
# observations stay in history.
def test_retired_space_leaves_driver_view_after_publish(client, admin_headers, adapters, settings):
    image_id = upload_photo(client, admin_headers, 1)
    assert run_worker(adapters, settings).outcome == "completed"
    assert "A-07" in {o.space_id for o in adapters.repository.list_observations(image_id)}

    edit(client, admin_headers, lambda b: space(b, "A-07").update(retired=True))
    assert "A-07" in {s["spaceId"] for s in client.get("/lots/test-lot").json()["layout"]["spaces"]}
    report = validate(client, admin_headers)
    assert report["diff"]["retired"] == ["A-07"]
    assert [w["code"] for w in report["warnings"]] == ["retired_with_outlines"]
    publish_ok(client, admin_headers)

    lot = client.get("/lots/test-lot").json()
    assert "A-07" not in {s["spaceId"] for s in lot["layout"]["spaces"]}
    status = client.get("/lots/test-lot/status").json()
    assert "A-07" not in {s["spaceId"] for s in status["spaces"]}
    assert "A-07" in {o.space_id for o in adapters.repository.list_observations(image_id)}
    snapshot = adapters.repository.get_published_layout("test-lot")
    assert next(s for s in snapshot.spaces if s.space_id == "A-07").retired


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_corner_is_422(client, admin_headers, literal):
    # Browsers serialize NaN as null (a 422 already), but Python's json parser accepts the bare
    # NaN/Infinity literals a raw client can send. Stored, such a corner becomes null and the
    # draft, and any layout published from it, no longer loads.
    body = as_body(get_draft(client, admin_headers))
    view(body, "V1")["outlines"]["A-01"][0] = ["__X__", 0.1]
    raw = json.dumps(body).replace('"__X__"', literal)
    r = client.put(
        "/admin/lots/test-lot/layout/draft",
        content=raw,
        headers={**admin_headers, "Content-Type": "application/json"},
    )
    assert r.status_code == 422
    assert r.json()["error"] == "validation_error"
    assert get_draft(client, admin_headers)["revision"] == 0


@pytest.mark.parametrize("field", ["x", "w"])
@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_rect_is_422(client, admin_headers, field, literal):
    # As for corners: a NaN rect validated as inside the map, published, and the snapshot it
    # was stored in then failed to load for every driver.
    body = as_body(get_draft(client, admin_headers))
    space(body, "A-01")["rect"][field] = "__X__"
    raw = json.dumps(body).replace('"__X__"', literal)
    r = client.put(
        "/admin/lots/test-lot/layout/draft",
        content=raw,
        headers={**admin_headers, "Content-Type": "application/json"},
    )
    assert r.status_code == 422
    assert r.json()["error"] == "validation_error"
    assert get_draft(client, admin_headers)["revision"] == 0


def test_zero_size_rect_blocks_publishing(client, admin_headers):
    edit(
        client,
        admin_headers,
        lambda b: space(b, "A-01").update(rect={"x": 80, "y": 80, "w": 0, "h": 0}),
    )
    report = validate(client, admin_headers)
    assert [e["code"] for e in report["errors"]] == ["bad_rect"]
    assert report["errors"][0]["spaceIds"] == ["A-01"]
    r = publish(client, admin_headers)
    assert r.status_code == 409 and r.json()["error"] == "validation_failed"
