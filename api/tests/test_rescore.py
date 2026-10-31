"""Publishing re-scores the latest photo against the new version (HDD §4.6): spaces new in the
layout get a state without another upload, and the original snapshot keeps its version."""

from __future__ import annotations

from parking_api.jobs import rescore_latest
from parking_core.models import JobStatus

from .conftest import NOW
from .test_layout import (
    LAYOUT,
    NEW_SPACE,
    add_new_space,
    edit,
    publish_ok,
    run_worker,
    upload_photo,
)


def status_of(client, space_id: str) -> dict | None:
    body = client.get("/lots/test-lot/status").json()
    return next((s for s in body["spaces"] if s["spaceId"] == space_id), None)


def queued(adapters) -> list:
    return [
        s
        for s in adapters.repository.list_snapshots("test-lot")
        if s.job_status is JobStatus.QUEUED
    ]


def test_publish_rescores_the_latest_photo_for_new_spaces(
    client, admin_headers, adapters, settings
):
    original = upload_photo(client, admin_headers, 1)
    assert run_worker(adapters, settings).outcome == "completed"
    v_before = adapters.repository.get_snapshot(original).layout_version
    assert status_of(client, NEW_SPACE["spaceId"]) is None  # not in the layout yet

    edit(client, admin_headers, add_new_space)
    version = publish_ok(client, admin_headers)["version"]

    (rescore,) = queued(adapters)
    assert rescore.rescore_of == original and rescore.layout_version == version
    snap = adapters.repository.get_snapshot(original)
    assert (rescore.s3_key, rescore.sha256, rescore.capture_time) == (
        snap.s3_key,
        snap.sha256,
        snap.capture_time,
    )
    assert run_worker(adapters, settings).outcome == "completed"

    new = status_of(client, NEW_SPACE["spaceId"])
    assert new is not None and new["state"] in {"FREE", "OCCUPIED"}
    assert adapters.repository.get_snapshot(original).layout_version == v_before  # US-09 #5
    listed = client.get("/admin/snapshots?lotId=test-lot", headers=admin_headers).json()
    assert {s["rescoreOf"] for s in listed} == {None, original}


def test_rescore_updates_spaces_scored_before(client, admin_headers, adapters, settings):
    upload_photo(client, admin_headers, 1)
    run_worker(adapters, settings)
    publish_ok(client, admin_headers)
    (rescore,) = queued(adapters)
    run_worker(adapters, settings)
    statuses = adapters.repository.get_statuses("test-lot")
    assert statuses and all(s.source_image_id == rescore.image_id for s in statuses)


def test_publish_with_no_processed_photo_queues_nothing(client, admin_headers, adapters):
    upload_photo(client, admin_headers, 1)  # queued, never processed
    before = len(queued(adapters))
    publish_ok(client, admin_headers)
    assert len(queued(adapters)) == before


def test_no_second_rescore_for_the_same_version(client, admin_headers, adapters, settings):
    upload_photo(client, admin_headers, 1)
    run_worker(adapters, settings)
    publish_ok(client, admin_headers)
    run_worker(adapters, settings)
    version = adapters.repository.get_lot("test-lot").current_layout_version
    assert rescore_latest(adapters, "test-lot", version, "a@x.edu", NOW) == []


def test_a_failing_rescore_never_fails_the_publish(
    client, admin_headers, adapters, settings, monkeypatch
):
    upload_photo(client, admin_headers, 1)
    run_worker(adapters, settings)

    def broken(*args, **kwargs):
        raise RuntimeError("queue down")

    monkeypatch.setattr(adapters.queue, "send", broken)
    r = client.post(
        f"{LAYOUT}/publish",
        json={"revision": edit(client, admin_headers, lambda b: None)["revision"]},
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
