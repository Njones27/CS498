"""A stall the photo cuts off is outlined up to the border and never called Free from that
photo; another viewpoint that sees it whole decides it."""

from __future__ import annotations

from datetime import timedelta

from .conftest import NOW
from .integration_helpers import FREE, OCCUPIED, UNKNOWN, run_worker, scripted_scorer, upload_photo
from .test_layout import edit, publish_ok, view


def cut_off_b01(body: dict) -> None:
    """B-01 in V1 now reaches the photo's top border: the photo shows only part of it."""
    view(body, "V1")["outlines"]["B-01"] = [[0.1, 0.0], [0.2, 0.0], [0.2, 0.05], [0.1, 0.05]]


def state_of(client, space_id: str) -> dict:
    spaces = client.get("/lots/test-lot/status").json()["spaces"]
    return next(s for s in spaces if s["spaceId"] == space_id)


def test_a_cut_off_stall_is_never_free_from_that_photo(
    client, admin_headers, adapters, settings, clock
):
    edit(client, admin_headers, cut_off_b01)
    publish_ok(client, admin_headers)
    while adapters.queue.receive(max_messages=10, wait_seconds=0):
        pass  # drop any re-score queued by the publish
    upload_photo(client, admin_headers, "test-lot", "V1", b"v1", NOW - timedelta(minutes=2))
    run_worker(adapters, settings, scripted_scorer({}, default=FREE), clock)
    b01 = state_of(client, "B-01")
    assert b01["state"] == UNKNOWN  # looks empty on the visible part; a car may be out of view
    assert state_of(client, "A-01")["state"] == FREE  # whole stalls as before


def test_a_car_on_a_cut_off_stall_still_counts(client, admin_headers, adapters, settings, clock):
    edit(client, admin_headers, cut_off_b01)
    publish_ok(client, admin_headers)
    while adapters.queue.receive(max_messages=10, wait_seconds=0):
        pass
    upload_photo(client, admin_headers, "test-lot", "V1", b"v1", NOW - timedelta(minutes=2))
    run_worker(adapters, settings, scripted_scorer({"B-01": OCCUPIED}), clock)
    assert state_of(client, "B-01")["state"] == OCCUPIED


def test_the_view_that_sees_it_whole_decides(client, admin_headers, adapters, settings, clock):
    edit(client, admin_headers, cut_off_b01)
    publish_ok(client, admin_headers)
    while adapters.queue.receive(max_messages=10, wait_seconds=0):
        pass
    upload_photo(client, admin_headers, "test-lot", "V2", b"v2", NOW - timedelta(minutes=5))
    run_worker(adapters, settings, scripted_scorer({}, default=FREE), clock)
    upload_photo(client, admin_headers, "test-lot", "V1", b"v1", NOW - timedelta(minutes=1))
    run_worker(adapters, settings, scripted_scorer({}, default=FREE), clock)
    b01 = state_of(client, "B-01")  # V1's later partial Unknown does not blank out V2's Free
    assert b01["state"] == FREE and b01["views"] == ["V2"]
