"""Upload -> worker -> driver map across features: failed jobs and retries (US-06, US-12 #1),
duplicates (US-05), the processing note (US-11 #5) and newest-capture-wins (US-13)."""

from __future__ import annotations

from datetime import timedelta, timezone

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
    edit_draft,
    failing_scorer,
    publish_ok,
    quad,
    request_slot,
    retry,
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

V1_SPACES = ["A-01", "A-02", "A-03", "A-04", "A-05", "A-06", "A-07", "B-01", "B-02", "B-03"]


def snapshot_rows(client, headers, lot_id: str = "test-lot") -> list[dict]:
    r = client.get(f"/admin/snapshots?lotId={lot_id}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def test_failed_job_keeps_prior_states_then_retry_updates_map(
    client, admin_headers, adapters, settings, clock
):
    """US-06 #2, #3 / US-12 #1: a rejected photo contributes nothing; its retry does."""
    first = NOW - timedelta(minutes=10)
    upload_photo(client, admin_headers, "test-lot", "V1", b"photo-1", first)
    assert run_worker(adapters, settings, scripted_scorer({}), clock).outcome == "completed"
    assert (
        close(client, admin_headers, "test-lot", ["B-01"], NOW - timedelta(minutes=1)).status_code
        == 201
    )
    before = states(client, "test-lot")

    second = NOW - timedelta(minutes=5)
    image_id = upload_photo(client, admin_headers, "test-lot", "V1", b"photo-2", second)
    result = run_worker(adapters, settings, failing_scorer("Too few matches"), clock)
    assert result.outcome == "failed_permanent"

    row = next(r for r in snapshot_rows(client, admin_headers) if r["imageId"] == image_id)
    assert (row["jobStatus"], row["error"], row["finished"]) == ("FAILED", "Too few matches", True)
    after = states(client, "test-lot")
    assert after == before  # prior states and capture times unchanged
    assert after["A-01"] == (FREE, before["A-01"][1]) and at(after["A-01"][1]) == first
    assert after["B-04"] == (UNKNOWN, None)  # no prior observation stays UNKNOWN
    assert after["B-01"][0] == CLOSED  # active closures remain CLOSED
    st = status(client, "test-lot")
    assert at(st["lastObservedAt"]) == first and st["processing"] is False

    queued = retry(client, admin_headers, image_id)
    assert (queued["jobStatus"], queued["attempts"], queued["error"]) == ("QUEUED", 0, None)
    assert status(client, "test-lot")["processing"] is True
    result = run_worker(adapters, settings, scripted_scorer({}, default=OCCUPIED), clock)
    assert result.outcome == "completed"
    assert snapshot(client, admin_headers, image_id)["jobStatus"] == "COMPLETE"
    after = states(client, "test-lot")
    assert after["A-01"][0] == OCCUPIED and at(after["A-01"][1]) == second
    assert after["B-01"][0] == CLOSED
    assert after["B-04"] == (UNKNOWN, None)


def test_retrying_an_older_photo_does_not_overwrite_newer_results(
    client, admin_headers, adapters, settings, clock
):
    """US-06 #3: the retried photo shows only if it is the newest for its spaces."""
    old = upload_photo(client, admin_headers, "test-lot", "V1", b"old", NOW - timedelta(minutes=20))
    run_worker(adapters, settings, failing_scorer(), clock)
    newer = NOW - timedelta(minutes=5)
    upload_photo(client, admin_headers, "test-lot", "V1", b"new", newer)
    run_worker(adapters, settings, scripted_scorer({}), clock)

    retry(client, admin_headers, old)
    result = run_worker(adapters, settings, scripted_scorer({}, default=OCCUPIED), clock)
    assert result.outcome == "completed"
    assert snapshot(client, admin_headers, old)["jobStatus"] == "COMPLETE"
    got = states(client, "test-lot")
    for sid in V1_SPACES:
        assert got[sid][0] == FREE and at(got[sid][1]) == newer, sid


def test_retry_after_a_new_publish_keeps_the_photos_layout_version(
    client, admin_headers, adapters, settings, clock
):
    """US-09 #5 x US-06 #3: a retried photo is scored with the layout it was uploaded under."""
    image_id = upload_photo(
        client, admin_headers, "test-lot", "V1", b"v1-photo", NOW - timedelta(minutes=5)
    )
    run_worker(adapters, settings, failing_scorer(), clock)

    def retire_a07(body):
        next(s for s in body["spaces"] if s["spaceId"] == "A-07")["retired"] = True

    edit_draft(client, admin_headers, "test-lot", retire_a07)
    assert publish_ok(client, admin_headers, "test-lot")["version"] == 2

    retry(client, admin_headers, image_id)
    assert run_worker(adapters, settings, scripted_scorer({}), clock).outcome == "completed"
    assert snapshot(client, admin_headers, image_id)["layoutVersion"] == 1
    st = status(client, "test-lot")
    assert st["layoutVersion"] == 2
    assert "A-07" not in {s["spaceId"] for s in st["spaces"]}
    assert {s["spaceId"]: s["state"] for s in st["spaces"]}["A-06"] == FREE


def _published_lot(client, headers, name: str) -> str:
    lot_id = create_lot(client, headers, name)["lotId"]
    save_draft(
        client,
        headers,
        lot_id,
        spaces=[space("S-01", 0)],
        viewpoints=[{"viewId": "V1", "name": "Roof", "outlines": {"S-01": quad(1)}}],
    )
    upload_reference(client, headers, lot_id, "V1", f"{name} reference".encode())
    publish_ok(client, headers, lot_id)
    return lot_id


def test_reuploading_the_same_photo_is_refused_whatever_its_outcome(
    client, admin_headers, adapters, settings, clock
):
    """US-05 #1-#3: the contents decide, whether the original completed or failed."""
    north = _published_lot(client, admin_headers, "North Lot")
    done = upload_photo(
        client, admin_headers, "test-lot", "V1", b"done", NOW - timedelta(minutes=9)
    )
    run_worker(adapters, settings, scripted_scorer({}), clock)
    failed = upload_photo(
        client, admin_headers, "test-lot", "V1", b"failed", NOW - timedelta(minutes=8)
    )
    run_worker(adapters, settings, failing_scorer(), clock)
    counts = {lot: len(snapshot_rows(client, admin_headers, lot)) for lot in ("test-lot", north)}

    later = NOW - timedelta(minutes=1)
    for lot_id, view_id, data, original in (
        ("test-lot", "V1", b"done", done),
        ("test-lot", "V2", b"done", done),  # another viewpoint or time doesn't matter
        ("test-lot", "V1", b"failed", failed),
        (north, "V1", b"done", done),  # nor does another lot
    ):
        r = request_slot(client, admin_headers, lot_id, view_id, data, later)
        assert r.status_code == 409, (lot_id, view_id, r.text)
        assert r.json()["error"] == "duplicate"
        assert r.json()["originalImageId"] == original
    assert {lot: len(snapshot_rows(client, admin_headers, lot)) for lot in counts} == counts

    r = request_slot(client, admin_headers, "test-lot", "V1", b"donf", later)  # one byte changed
    assert r.status_code == 201, r.text


def test_processing_note_keeps_previous_results(client, admin_headers, adapters, settings, clock):
    """US-11 #5: a photo in flight never blanks the map."""
    first = NOW - timedelta(minutes=10)
    upload_photo(client, admin_headers, "test-lot", "V1", b"photo-1", first)
    run_worker(adapters, settings, scripted_scorer({"A-02": OCCUPIED}), clock)
    shown = states(client, "test-lot")

    upload_photo(client, admin_headers, "test-lot", "V1", b"photo-2", NOW - timedelta(minutes=5))
    st = status(client, "test-lot")
    assert st["processing"] is True
    assert states(client, "test-lot") == shown
    assert at(st["lastObservedAt"]) == first and st["noObservations"] is False

    run_worker(adapters, settings, scripted_scorer({}), clock)
    st = status(client, "test-lot")
    assert st["processing"] is False
    assert at(st["lastObservedAt"]) == NOW - timedelta(minutes=5)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "status.processing only checks the newest-captured snapshot, so a newer "
        "abandoned/failed upload hides an older queued job (US-11 #5), owner Nathan Jones"
    ),
)
@pytest.mark.parametrize("newer", ["abandoned", "failed"])
def test_processing_note_survives_a_newer_unfinished_upload(
    client, admin_headers, adapters, settings, clock, newer
):
    """US-11 #5 x US-04 #7 / US-06 #2: a newer photo that never produced results must not
    hide the note for an older photo that is still queued."""
    if newer == "abandoned":
        upload_photo(client, admin_headers, "test-lot", "V1", b"older", NOW - timedelta(minutes=10))
        # The tab was closed before the newer photo's bytes arrived; 16 minutes on it is EXPIRED.
        slot = request_slot(
            client, admin_headers, "test-lot", "V1", b"newer", NOW - timedelta(minutes=5)
        )
        assert slot.status_code == 201
        clock.now = NOW + timedelta(minutes=16)
    else:
        upload_photo(client, admin_headers, "test-lot", "V1", b"newer", NOW - timedelta(minutes=5))
        assert run_worker(adapters, settings, failing_scorer(), clock).outcome == "failed_permanent"
        upload_photo(client, admin_headers, "test-lot", "V1", b"older", NOW - timedelta(minutes=10))
    rows = snapshot_rows(client, admin_headers)
    assert [r["jobStatus"] for r in rows] == [
        "EXPIRED" if newer == "abandoned" else "FAILED",
        "QUEUED",
    ]
    assert status(client, "test-lot")["processing"] is True


def test_capture_time_decides_across_viewpoints(client, admin_headers, adapters, settings, clock):
    """US-13 #2, #4: B-01 is in V1 and V2; the later capture wins whatever order they finish
    in, and a capture time sent with another UTC offset is compared as the same instant."""
    v2_time = NOW - timedelta(minutes=5)
    upload_photo(client, admin_headers, "test-lot", "V2", b"v2", v2_time)
    run_worker(adapters, settings, scripted_scorer({}, default=OCCUPIED), clock)

    v1_time = (NOW - timedelta(minutes=10)).astimezone(timezone(timedelta(hours=-5)))
    upload_photo(client, admin_headers, "test-lot", "V1", b"v1", v1_time)
    run_worker(adapters, settings, scripted_scorer({}), clock)

    got = states(client, "test-lot")
    assert got["B-01"][0] == OCCUPIED and at(got["B-01"][1]) == v2_time
    assert got["A-01"][0] == FREE and at(got["A-01"][1]) == NOW - timedelta(minutes=10)
    assert at(status(client, "test-lot")["lastObservedAt"]) == v2_time
