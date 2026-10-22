"""Admin photo overlay: snapshot detail with outlines, car boxes, detections and a photo URL,
plus the test-only object route that serves the photo locally."""

from __future__ import annotations

from fastapi.testclient import TestClient
from parking_api.main import create_app
from parking_core.models import CarBox, JobStatus, SpaceObservation, SpaceState
from parking_core.settings import Settings

from .conftest import NOW
from .test_api import upload

BOX = CarBox(cls_name="car", conf=0.88, box=(0.1, 0.2, 0.3, 0.45))
STRAY = CarBox(cls_name="cell phone", conf=0.41, box=(0.7, 0.7, 0.95, 0.99))  # non-car class
POLYGON = [(0.1, 0.2), (0.25, 0.2), (0.25, 0.4), (0.1, 0.4)]


def complete(adapters, image_id: str) -> None:
    """What the worker writes on success, without running it."""
    repo = adapters.repository
    assert repo.transition_job(image_id, {JobStatus.QUEUED}, JobStatus.PROCESSING)
    repo.put_observations(
        [
            SpaceObservation(
                image_id=image_id,
                lot_id="test-lot",
                space_id="A-01",
                state=SpaceState.OCCUPIED,
                acpds_score=0.92,
                car_overlap=0.8,
                capture_time=NOW,
                polygon=POLYGON,
                car_boxes=[BOX],
            ),
            SpaceObservation(
                image_id=image_id,
                lot_id="test-lot",
                space_id="A-02",
                state=SpaceState.UNKNOWN,
                acpds_score=0.5,
                car_overlap=0.0,
                capture_time=NOW,
            ),
        ]
    )
    assert repo.transition_job(
        image_id,
        {JobStatus.PROCESSING},
        JobStatus.COMPLETE,
        finished=True,
        model_version="fake",
        detections=[BOX, STRAY],
    )


def test_detail_has_outlines_car_boxes_detections_and_photo(client, admin_headers, adapters):
    data = b"\xff\xd8\xff\xe0 a jpeg"
    image_id = upload(client, admin_headers, data=data)
    assert client.post(f"/admin/uploads/{image_id}/complete", headers=admin_headers).is_success
    complete(adapters, image_id)

    r = client.get(f"/admin/snapshots/{image_id}", headers=admin_headers)
    assert r.status_code == 200
    detail = r.json()
    assert detail["jobStatus"] == "COMPLETE"
    assert detail["detections"] == [
        {"clsName": "car", "conf": 0.88, "box": [0.1, 0.2, 0.3, 0.45]},
        {"clsName": "cell phone", "conf": 0.41, "box": [0.7, 0.7, 0.95, 0.99]},
    ]
    obs = {o["spaceId"]: o for o in detail["observations"]}
    assert obs["A-01"]["polygon"] == [list(p) for p in POLYGON]
    assert obs["A-01"]["carBoxes"] == [detail["detections"][0]]
    assert obs["A-02"]["polygon"] is None and obs["A-02"]["carBoxes"] == []

    photo_url = detail["photoUrl"]
    assert photo_url.startswith("/api/_test/objects/raw/test-lot/V1/")
    photo = client.get(photo_url.removeprefix("/api"))
    assert photo.status_code == 200
    assert photo.content == data
    assert photo.headers["content-type"] == "image/jpeg"


def test_detail_without_a_stored_photo_has_no_url(client, admin_headers):
    r = client.post(
        "/admin/uploads",
        json={
            "lotId": "test-lot",
            "viewId": "V1",
            "captureTime": NOW.isoformat(),
            "sha256": "b" * 64,
            "contentType": "image/png",
            "sizeBytes": 10,
        },
        headers=admin_headers,
    )
    image_id = r.json()["imageId"]  # slot issued, nothing PUT yet
    detail = client.get(f"/admin/snapshots/{image_id}", headers=admin_headers).json()
    assert detail["photoUrl"] is None
    assert detail["detections"] == [] and detail["observations"] == []


def test_test_object_route_serves_bytes_and_404s(client, adapters):
    adapters.object_store.put("raw/x/V1/img.png", b"\x89PNG data", "image/png")
    r = client.get("/_test/objects/raw/x/V1/img.png")
    assert r.status_code == 200
    assert r.content == b"\x89PNG data" and r.headers["content-type"] == "image/png"
    r = client.get("/_test/objects/raw/x/V1/missing.png")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_test_object_route_absent_outside_test(adapters):
    adapters.object_store.put("raw/x/V1/img.png", b"data", "image/png")
    s = Settings(app_env="local", _env_file=None)  # type: ignore[call-arg]
    r = TestClient(create_app(s, adapters)).get("/_test/objects/raw/x/V1/img.png")
    assert r.status_code == 404
