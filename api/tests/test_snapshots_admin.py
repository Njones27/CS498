"""US-06 snapshot list, retry and detail as the Snapshots page uses them: one test per
acceptance criterion. The page itself is tested in `web/src/pages/snapshots.test.tsx`."""

from __future__ import annotations

from datetime import timedelta

from parking_core.keys import raw_photo_key
from parking_core.models import (
    Cutoffs,
    JobStatus,
    Snapshot,
    SpaceObservation,
    SpaceState,
)
from parking_worker.aligners.identity import IdentityAligner
from parking_worker.poller import run_once
from parking_worker.scorers.stub import StubScorer

from .conftest import NOW

LIST = "/admin/snapshots?lotId=test-lot"


def add(adapters, image_id, minutes_ago, status=JobStatus.COMPLETE, view="V1", **fields):
    key = raw_photo_key("test-lot", view, image_id)
    adapters.object_store.put(key, f"photo-{image_id}".encode(), "image/jpeg")
    adapters.repository.put_snapshot(
        Snapshot(
            image_id=image_id,
            lot_id="test-lot",
            view_id=view,
            capture_time=NOW - timedelta(minutes=minutes_ago),
            sha256=image_id.ljust(64, "0"),
            s3_key=key,
            content_type="image/jpeg",
            size_bytes=10,
            uploaded_by="admin@example.edu",
            job_status=status,
            created_at=NOW - timedelta(minutes=minutes_ago),
            **fields,
        )
    )


def rows(client, headers) -> dict[str, dict]:
    r = client.get(LIST, headers=headers)
    assert r.status_code == 200, r.text
    return {s["imageId"]: s for s in r.json()}


def test_recent_snapshots_are_listed(client, admin_headers, adapters):
    add(adapters, "img-1320", 45, JobStatus.QUEUED)
    add(adapters, "img-1405", 0, finished=True, processing_ms=18_000, model_version="stub-0")
    add(adapters, "img-1350", 15, JobStatus.PROCESSING, view="V2")
    r = client.get(LIST, headers=admin_headers)
    assert [s["imageId"] for s in r.json()] == ["img-1405", "img-1350", "img-1320"]
    top = r.json()[0]
    assert top["viewId"] == "V1" and top["jobStatus"] == "COMPLETE"
    assert top["processingMs"] == 18_000 and top["modelVersion"] == "stub-0"
    assert top["error"] is None


def test_failed_job_shows_its_error(client, admin_headers, adapters):
    add(adapters, "img-1", 5, JobStatus.QUEUED)
    adapters.repository.transition_job(
        "img-1", {JobStatus.QUEUED}, JobStatus.FAILED, finished=True, error="Too few matches"
    )
    row = rows(client, admin_headers)["img-1"]
    assert row["jobStatus"] == "FAILED" and row["finished"] is True
    assert row["error"] == "Too few matches"


def test_retry_a_failed_job(client, admin_headers, adapters):
    add(adapters, "img-1", 5, JobStatus.FAILED, finished=True, attempts=1, error="boom")
    r = client.post("/admin/snapshots/img-1/retry", headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.json()["jobStatus"] == "QUEUED"
    assert rows(client, admin_headers)["img-1"]["jobStatus"] == "QUEUED"

    # The worker then picks it up: QUEUED -> COMPLETE.
    run_once(adapters, IdentityAligner(), StubScorer(), Cutoffs(), wait_seconds=0)
    row = rows(client, admin_headers)["img-1"]
    assert row["jobStatus"] == "COMPLETE" and row["error"] is None
    assert row["layoutVersion"] == 1


def test_retry_only_where_it_makes_sense(client, admin_headers, adapters):
    add(adapters, "done", 1, JobStatus.COMPLETE, finished=True)
    add(adapters, "queued", 2, JobStatus.QUEUED)
    add(adapters, "busy", 3, JobStatus.PROCESSING)
    add(adapters, "will-retry", 4, JobStatus.FAILED, finished=False, error="flaky")
    for image_id in ("done", "queued", "busy", "will-retry"):
        r = client.post(f"/admin/snapshots/{image_id}/retry", headers=admin_headers)
        assert r.status_code == 409 and r.json()["error"] == "not_retryable", image_id


def test_repeated_failures_stop_automatically(client, admin_headers, adapters):
    add(
        adapters,
        "img-1",
        5,
        JobStatus.FAILED,
        finished=True,
        attempts=3,
        error="Failed after 3 attempts",
    )
    row = rows(client, admin_headers)["img-1"]
    assert row["jobStatus"] == "FAILED" and row["finished"] is True
    assert row["error"] == "Failed after 3 attempts"
    assert client.post("/admin/snapshots/img-1/retry", headers=admin_headers).status_code == 200


def test_snapshot_detail(client, admin_headers, adapters):
    add(adapters, "img-1", 5, finished=True, layout_version=1, model_version="stub-0")
    adapters.repository.put_observations(
        [
            SpaceObservation(
                image_id="img-1",
                lot_id="test-lot",
                space_id="A-01",
                state=SpaceState.OCCUPIED,
                acpds_score=0.91,
                car_overlap=0.62,
                capture_time=NOW,
            ),
            SpaceObservation(
                image_id="img-1",
                lot_id="test-lot",
                space_id="A-02",
                state=SpaceState.UNKNOWN,
                acpds_score=None,
                car_overlap=0.0,
                in_frame=False,
                capture_time=NOW,
            ),
        ]
    )
    r = client.get("/admin/snapshots/img-1", headers=admin_headers)
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["layoutVersion"] == 1 and detail["modelVersion"] == "stub-0"
    obs = {o["spaceId"]: o for o in detail["observations"]}
    assert obs["A-01"] | {"polygon": None} == {
        "spaceId": "A-01",
        "state": "OCCUPIED",
        "acpdsScore": 0.91,
        "carOverlap": 0.62,
        "inFrame": True,
        "polygon": None,
    }
    assert obs["A-02"]["acpdsScore"] is None and obs["A-02"]["inFrame"] is False
