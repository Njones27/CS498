from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from parking_api.export_openapi import export
from parking_api.main import create_app
from parking_core.keys import layout_snapshot_key
from parking_core.models import JobStatus, SpaceObservation, SpaceState, SpaceStatus
from parking_core.settings import Settings

from .conftest import NOW, token

ROOT = Path(__file__).resolve().parents[2]

ADMIN_ROUTES = [
    ("post", "/admin/uploads", {"json": {}}),
    ("post", "/admin/uploads/x/complete", {}),
    ("get", "/admin/snapshots?lotId=test-lot", {}),
    ("get", "/admin/snapshots/x", {}),
    ("post", "/admin/snapshots/x/retry", {}),
]


def body(sha: str = "a" * 64, **kw):
    base = {
        "lotId": "test-lot",
        "viewId": "V1",
        "captureTime": (NOW - timedelta(minutes=5)).isoformat(),
        "sha256": sha,
        "contentType": "image/jpeg",
        "sizeBytes": 1000,
    }
    base.update(kw)
    return base


def sha(n: int) -> str:
    return hashlib.sha256(str(n).encode()).hexdigest()


def upload(client, headers, data=b"jpegbytes", put_type="image/jpeg", **kw):
    kw.setdefault("sizeBytes", len(data))
    r = client.post("/admin/uploads", json=body(**kw), headers=headers)
    assert r.status_code == 201, r.text
    slot = r.json()
    put = client.put(
        slot["uploadUrl"].removeprefix("/api"), content=data, headers={"content-type": put_type}
    )
    assert put.status_code == 204
    return slot["imageId"]


class FailingQueue:
    def send(self, body: str) -> None:
        raise RuntimeError("queue down")


# --- auth -------------------------------------------------------------------


@pytest.mark.parametrize(("method", "path", "kw"), ADMIN_ROUTES)
def test_admin_routes_require_admin(client, viewer_headers, settings, method, path, kw):
    assert getattr(client, method)(path, **kw).status_code == 401
    r = getattr(client, method)(path, headers=viewer_headers, **kw)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    old = token(settings, settings.dev_admin_email, ["admin"], now=NOW - timedelta(days=1))
    r = getattr(client, method)(path, headers={"Authorization": f"Bearer {old}"}, **kw)
    assert r.status_code == 401 and r.json()["error"] == "session_expired"


def test_login(client, settings):
    r = client.post(
        "/auth/login",
        json={"email": settings.dev_admin_email, "password": settings.dev_admin_password},
    )
    assert r.status_code == 200
    assert r.json()["groups"] == ["admin"]
    r = client.post("/auth/login", json={"email": settings.dev_admin_email, "password": "nope"})
    assert r.status_code == 401
    assert r.json() == {
        "error": "invalid_credentials",
        "message": "Email or password is incorrect",
    }


def test_login_404_in_cognito_mode(adapters):
    s = Settings(app_env="test", auth_mode="cognito", _env_file=None)  # type: ignore[call-arg]
    r = TestClient(create_app(s, adapters)).post(
        "/auth/login", json={"email": "a", "password": "b"}
    )
    assert r.status_code == 404


# --- public -----------------------------------------------------------------


def test_lots_lists_only_published(client):
    r = client.get("/lots")
    assert r.status_code == 200
    lots = r.json()
    assert [lot["lotId"] for lot in lots] == ["test-lot"]
    assert lots[0]["layoutVersion"] == 1
    assert lots[0]["summary"] == {
        "free": 0,
        "occupied": 0,
        "unknown": 14,
        "closed": 0,
        "total": 14,
        "openPercent": None,
        "isStale": False,
        "hasRecentData": False,
    }


def test_lots_summary_with_statuses(client, adapters):
    for sid in ("A-01", "A-02"):
        adapters.repository.update_status_if_newer(
            SpaceStatus(
                lot_id="test-lot",
                space_id=sid,
                state=SpaceState.FREE,
                observed_at=NOW - timedelta(minutes=1),
                source_image_id="i",
            )
        )
    summary = client.get("/lots").json()[0]["summary"]
    assert summary["free"] == 2 and summary["openPercent"] == 14 and summary["hasRecentData"]


def test_unloadable_snapshot_counts_as_unpublished(client, adapters, caplog):
    # A snapshot that no longer loads (here a null schematic width) must not fail GET /lots
    # for every driver: that lot is left out, and the error is logged.
    key = layout_snapshot_key("test-lot", 1)
    data = json.loads(adapters.object_store.get(key))
    data["schematic"]["width"] = None
    adapters.object_store.put(key, json.dumps(data).encode(), "application/json")
    with caplog.at_level(logging.ERROR, logger="parking_api.routes.public"):
        r = client.get("/lots")
    assert r.status_code == 200 and r.json() == []
    assert "Published layout of lot test-lot v1 does not load" in caplog.text
    assert client.get("/lots/test-lot").status_code == 404
    assert client.get("/lots/test-lot/status").status_code == 404


def test_lot_detail(client):
    r = client.get("/lots/test-lot")
    assert r.status_code == 200
    d = r.json()
    assert len(d["layout"]["spaces"]) == 14
    assert d["layout"]["spaces"][0]["type"] == "ADA"
    assert d["viewpoints"] == [
        {"viewId": "V1", "name": "North corner"},
        {"viewId": "V2", "name": "South corner"},
    ]
    assert client.get("/lots/draft").status_code == 404
    assert client.get("/lots/nope").status_code == 404


def test_status_no_observations(client):
    r = client.get("/lots/test-lot/status")
    assert r.status_code == 200
    s = r.json()
    assert s["noObservations"] is True and s["processing"] is False
    assert s["counts"]["unknown"] == 14
    assert client.get("/lots/draft/status").status_code == 404


# --- uploads ----------------------------------------------------------------


def test_upload_complete_flow(client, admin_headers, adapters):
    image_id = upload(client, admin_headers)
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert r.status_code == 200
    assert r.json() == {"imageId": image_id, "jobStatus": "QUEUED"}
    snap = adapters.repository.get_snapshot(image_id)
    assert snap.job_status is JobStatus.QUEUED and snap.layout_version == 1
    assert len(adapters.queue) == 1
    assert client.get("/lots/test-lot/status").json()["processing"] is True
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert r.status_code == 409 and r.json()["error"] == "not_pending"


def test_complete_errors(client, admin_headers, clock):
    assert client.post("/admin/uploads/nope/complete", headers=admin_headers).status_code == 404
    r = client.post("/admin/uploads", json=body(), headers=admin_headers)
    image_id = r.json()["imageId"]
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert r.status_code == 409 and r.json()["error"] == "missing_object"
    clock.now = NOW + timedelta(minutes=16)
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert r.status_code == 410 and r.json()["error"] == "expired"


def test_duplicate(client, admin_headers):
    first = upload(client, admin_headers)
    r = client.post("/admin/uploads", json=body(), headers=admin_headers)
    assert r.status_code == 409
    err = r.json()
    assert err["error"] == "duplicate" and err["originalImageId"] == first
    assert err["message"].startswith("This photo was already uploaded on ")
    assert err["uploadedAt"].startswith("2026-10-01T12:00")


def test_duplicate_race_one_wins(client, admin_headers):
    barrier = threading.Barrier(2)
    codes: list[int] = []

    def go():
        barrier.wait()
        codes.append(client.post("/admin/uploads", json=body(), headers=admin_headers).status_code)

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [201, 409]


def test_expired_original_is_taken_over(client, admin_headers, clock):
    r = client.post("/admin/uploads", json=body(), headers=admin_headers)
    original = r.json()["imageId"]
    clock.now = NOW + timedelta(minutes=16)
    r = client.post("/admin/uploads", json=body(), headers=admin_headers)
    assert r.status_code == 201 and r.json()["imageId"] != original
    r = client.post("/admin/uploads", json=body(), headers=admin_headers)
    assert r.status_code == 409


@pytest.mark.parametrize(
    ("kw", "code"),
    [
        ({"captureTime": (NOW + timedelta(minutes=1)).isoformat()}, "future_capture_time"),
        ({"sizeBytes": 15 * 1024 * 1024 + 1}, "too_large"),
        ({"viewId": "V9"}, "unknown_viewpoint"),
    ],
)
def test_upload_validation(client, admin_headers, kw, code):
    r = client.post("/admin/uploads", json=body(**kw), headers=admin_headers)
    assert r.status_code == 422 and r.json()["error"] == code


def test_upload_unsupported_type(adapters, admin_headers, clock):
    s = Settings(app_env="test", allowed_upload_types=("image/png",), _env_file=None)  # type: ignore[call-arg]
    app = create_app(s, adapters)
    app.state.now = clock
    r = TestClient(app).post("/admin/uploads", json=body(), headers=admin_headers)
    assert r.status_code == 422 and r.json()["error"] == "unsupported_type"
    # The contract-level enum rejects other types before the handler runs.
    r = TestClient(app).post(
        "/admin/uploads", json=body(contentType="image/gif"), headers=admin_headers
    )
    assert r.status_code == 422


def test_upload_unpublished_lot(client, admin_headers):
    r = client.post("/admin/uploads", json=body(lotId="draft"), headers=admin_headers)
    assert r.status_code == 404


def test_naive_capture_time_is_rejected(client, admin_headers):
    naive = (NOW - timedelta(minutes=5)).replace(tzinfo=None).isoformat()
    r = client.post("/admin/uploads", json=body(captureTime=naive), headers=admin_headers)
    assert r.status_code == 422 and r.json()["error"] == "validation_error"


def test_capture_time_is_stored_in_utc(client, admin_headers, adapters):
    r = client.post(
        "/admin/uploads",
        json=body(captureTime="2026-10-01T06:55:00-05:00"),
        headers=admin_headers,
    )
    assert r.status_code == 201
    snap = adapters.repository.get_snapshot(r.json()["imageId"])
    assert snap.capture_time == NOW - timedelta(minutes=5)
    assert snap.capture_time.utcoffset() == timedelta(0)


@pytest.mark.parametrize("target", ["repository.put_snapshot", "object_store.presign_put"])
def test_failed_upload_request_releases_hash(app, adapters, admin_headers, monkeypatch, target):
    owner, attr = target.split(".")

    def boom(*args, **kwargs):
        raise RuntimeError("storage down")

    monkeypatch.setattr(getattr(adapters, owner), attr, boom)
    client = TestClient(app, raise_server_exceptions=False)
    assert client.post("/admin/uploads", json=body(), headers=admin_headers).status_code == 500
    monkeypatch.undo()
    assert client.post("/admin/uploads", json=body(), headers=admin_headers).status_code == 201


def test_orphaned_claim_is_taken_over_after_grace(client, admin_headers, adapters):
    repo = adapters.repository
    repo.claim_hash(sha(1), "ghost-old", claimed_at=NOW - timedelta(minutes=2))
    r = client.post("/admin/uploads", json=body(sha=sha(1)), headers=admin_headers)
    assert r.status_code == 201
    # A snapshot-less claim inside the grace window is a concurrent request still in flight.
    repo.claim_hash(sha(2), "ghost-new", claimed_at=NOW - timedelta(seconds=10))
    r = client.post("/admin/uploads", json=body(sha=sha(2)), headers=admin_headers)
    assert r.status_code == 409 and r.json()["originalImageId"] == "ghost-new"


def test_complete_size_mismatch(client, admin_headers):
    image_id = upload(client, admin_headers, data=b"abc", sizeBytes=10)
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert r.status_code == 409 and r.json()["error"] == "size_mismatch"


def test_complete_unsupported_stored_type(client, admin_headers, adapters):
    image_id = upload(client, admin_headers, put_type="image/gif")
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert r.status_code == 409 and r.json()["error"] == "unsupported_type"
    assert adapters.repository.get_snapshot(image_id).job_status is JobStatus.UPLOAD_PENDING


def test_complete_accepts_content_type_parameters(client, admin_headers):
    image_id = upload(client, admin_headers, put_type="image/jpeg; charset=binary")
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert r.status_code == 200


def test_queue_send_failure_marks_job_failed(app, adapters, admin_headers):
    client = TestClient(app, raise_server_exceptions=False)
    image_id = upload(client, admin_headers)
    real_queue, adapters.queue = adapters.queue, FailingQueue()
    r = client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert r.status_code == 500
    snap = adapters.repository.get_snapshot(image_id)
    assert snap.job_status is JobStatus.FAILED and snap.finished
    assert snap.error == "Could not queue job"
    # Retry with the queue still down fails the same way, and stays retryable.
    r = client.post(f"/admin/snapshots/{image_id}/retry", headers=admin_headers)
    assert r.status_code == 500
    assert adapters.repository.get_snapshot(image_id).job_status is JobStatus.FAILED
    adapters.queue = real_queue
    r = client.post(f"/admin/snapshots/{image_id}/retry", headers=admin_headers)
    assert r.status_code == 200 and r.json()["jobStatus"] == "QUEUED"
    assert len(real_queue) == 1


# --- snapshots --------------------------------------------------------------


def test_snapshot_list_and_expiry(client, admin_headers, clock):
    a = client.post("/admin/uploads", json=body(sha=sha(1)), headers=admin_headers).json()
    later = (NOW - timedelta(minutes=1)).isoformat()
    b = client.post(
        "/admin/uploads", json=body(sha=sha(2), captureTime=later), headers=admin_headers
    ).json()
    r = client.get("/admin/snapshots?lotId=test-lot", headers=admin_headers)
    assert [s["imageId"] for s in r.json()] == [b["imageId"], a["imageId"]]
    assert {s["jobStatus"] for s in r.json()} == {"UPLOAD_PENDING"}
    clock.now = NOW + timedelta(minutes=15, seconds=1)
    r = client.get("/admin/snapshots?lotId=test-lot&limit=1", headers=admin_headers)
    assert len(r.json()) == 1 and r.json()[0]["jobStatus"] == "EXPIRED"


def test_snapshot_detail(client, admin_headers, adapters):
    image_id = upload(client, admin_headers)
    adapters.repository.put_observations(
        [
            SpaceObservation(
                image_id=image_id,
                lot_id="test-lot",
                space_id="A-01",
                state=SpaceState.FREE,
                acpds_score=0.1,
                car_overlap=0.0,
                capture_time=NOW,
            )
        ]
    )
    r = client.get(f"/admin/snapshots/{image_id}", headers=admin_headers)
    assert r.status_code == 200
    assert r.json()["observations"][0]["spaceId"] == "A-01"
    assert client.get("/admin/snapshots/nope", headers=admin_headers).status_code == 404


def test_retry(client, admin_headers, adapters):
    repo = adapters.repository
    image_id = upload(client, admin_headers)
    client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers)
    assert (
        client.post(f"/admin/snapshots/{image_id}/retry", headers=admin_headers).status_code == 409
    )
    repo.transition_job(image_id, {JobStatus.QUEUED}, JobStatus.FAILED, finished=False)
    r = client.post(f"/admin/snapshots/{image_id}/retry", headers=admin_headers)
    assert r.status_code == 409 and r.json()["error"] == "not_retryable"
    repo.transition_job(
        image_id, {JobStatus.FAILED}, JobStatus.FAILED, finished=True, attempts=3, error="boom"
    )
    r = client.post(f"/admin/snapshots/{image_id}/retry", headers=admin_headers)
    assert r.status_code == 200
    out = r.json()
    assert out["jobStatus"] == "QUEUED" and out["attempts"] == 0 and out["error"] is None
    assert len(adapters.queue) == 2
    assert client.post("/admin/snapshots/nope/retry", headers=admin_headers).status_code == 404


# --- test-only route & contract ---------------------------------------------


def test_test_upload_unknown_image(client):
    assert client.put("/_test/uploads/nope", content=b"x").status_code == 404


def test_test_upload_route_absent_outside_test(adapters):
    s = Settings(app_env="local", _env_file=None)  # type: ignore[call-arg]
    r = TestClient(create_app(s, adapters)).put("/_test/uploads/x", content=b"x")
    assert r.status_code == 404


def test_openapi_matches_committed_contract():
    assert export() == (ROOT / "contract" / "openapi.json").read_text()
