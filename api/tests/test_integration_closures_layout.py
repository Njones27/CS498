"""Closures across layout changes (US-10 x US-09) and the lot list against the map (US-15)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from parking_core.models import SpaceState, SpaceStatus

from .conftest import NOW
from .integration_helpers import (
    CLOSED,
    FREE,
    close,
    create_lot,
    driver_lots,
    edit_draft,
    publish_ok,
    save_draft,
    space,
    states,
    status,
)


def closure_spaces(client, headers, lot_id: str = "test-lot") -> list[list[str]]:
    r = client.get(f"/admin/lots/{lot_id}/closures", headers=headers)
    assert r.status_code == 200, r.text
    return [c["spaceIds"] for c in r.json()]


def set_retired(space_id: str, retired: bool):
    def change(body: dict) -> None:
        next(s for s in body["spaces"] if s["spaceId"] == space_id)["retired"] = retired

    return change


def test_closure_survives_republish(client, admin_headers):
    r = close(client, admin_headers, "test-lot", ["B-03", "B-04"], NOW - timedelta(minutes=1))
    assert r.status_code == 201, r.text
    assert publish_ok(client, admin_headers, "test-lot")["version"] == 2
    got = states(client, "test-lot")
    assert (got["B-03"][0], got["B-04"][0]) == (CLOSED, CLOSED)
    assert status(client, "test-lot")["counts"]["closed"] == 2


def test_retiring_a_closed_space_then_restoring_it(client, admin_headers):
    r = close(client, admin_headers, "test-lot", ["B-03", "B-04"], NOW - timedelta(minutes=1))
    assert r.status_code == 201, r.text

    edit_draft(client, admin_headers, "test-lot", set_retired("B-04", True))
    publish_ok(client, admin_headers, "test-lot")
    st = status(client, "test-lot")
    assert "B-04" not in {s["spaceId"] for s in st["spaces"]}
    assert st["counts"]["closed"] == 1
    assert driver_lots(client)["test-lot"]["summary"]["closed"] == 1
    assert closure_spaces(client, admin_headers) == [["B-03", "B-04"]]  # the record is kept
    r = close(client, admin_headers, "test-lot", ["B-04"], NOW)
    assert r.status_code == 422 and r.json()["error"] == "unknown_space"

    r = client.post("/admin/lots/test-lot/layout/versions/1/restore", headers=admin_headers)
    assert r.status_code == 200, r.text
    assert publish_ok(client, admin_headers, "test-lot")["version"] == 3
    got = states(client, "test-lot")
    assert (got["B-03"][0], got["B-04"][0]) == (CLOSED, CLOSED)
    assert status(client, "test-lot")["counts"]["closed"] == 2


def _set_states(adapters, lot_id: str, by_state: dict[SpaceState, list[str]]) -> None:
    for state, space_ids in by_state.items():
        for sid in space_ids:
            adapters.repository.update_status_if_newer(
                SpaceStatus(
                    lot_id=lot_id,
                    space_id=sid,
                    state=state,
                    observed_at=NOW - timedelta(minutes=5),
                    source_image_id="img",
                )
            )


def _assert_list_matches_map(client, lot_id: str) -> dict:
    summary = driver_lots(client)[lot_id]["summary"]
    counts = status(client, lot_id)["counts"]
    assert {k: summary[k] for k in counts} == counts
    assert summary["total"] == len(status(client, lot_id)["spaces"]) - counts["closed"]
    return summary


def test_lot_list_matches_the_map(client, admin_headers, adapters):
    """US-15 #3, #7 / US-12 #4 on Test Lot: a closed space that last read FREE is not open."""
    _set_states(
        adapters,
        "test-lot",
        {
            SpaceState.FREE: ["A-01", "A-02", "A-03", "A-04", "B-06"],
            SpaceState.OCCUPIED: ["A-05", "A-06", "A-07", "B-01", "B-02", "B-03"],
            SpaceState.UNKNOWN: ["B-04", "B-05"],
        },
    )
    r = close(client, admin_headers, "test-lot", ["B-06", "B-07"], NOW - timedelta(minutes=1))
    assert r.status_code == 201, r.text
    assert states(client, "test-lot")["B-06"][0] == CLOSED
    summary = _assert_list_matches_map(client, "test-lot")
    assert (summary["free"], summary["occupied"], summary["unknown"], summary["closed"]) == (
        4,
        6,
        2,
        2,
    )
    assert (summary["total"], summary["openPercent"]) == (12, 33)


@pytest.mark.parametrize("reopen", [False, True])
def test_us15_example_north_lot_shows_5_of_18(client, admin_headers, adapters, reopen):
    """US-15 #3 as written: 20 spaces, 5 free, 10 occupied, 3 unknown and 2 closed is 5/18
    and 28 percent. Ending the closure early puts both spaces back in the total."""
    lot_id = create_lot(client, admin_headers, "North Lot")["lotId"]
    ids = [f"N-{i:02d}" for i in range(1, 21)]
    save_draft(
        client,
        admin_headers,
        lot_id,
        spaces=[space(sid, i) for i, sid in enumerate(ids)],
        viewpoints=[],
    )
    publish_ok(client, admin_headers, lot_id)
    _set_states(
        adapters,
        lot_id,
        {SpaceState.FREE: ids[:5], SpaceState.OCCUPIED: ids[5:15], SpaceState.UNKNOWN: ids[15:18]},
    )
    r = close(client, admin_headers, lot_id, ids[18:], NOW - timedelta(minutes=1))
    assert r.status_code == 201, r.text
    summary = _assert_list_matches_map(client, lot_id)
    assert (summary["free"], summary["total"], summary["openPercent"]) == (5, 18, 28)

    if reopen:
        closure_id = r.json()["closureId"]
        ended = client.delete(f"/admin/lots/{lot_id}/closures/{closure_id}", headers=admin_headers)
        assert ended.status_code == 200, ended.text
        summary = _assert_list_matches_map(client, lot_id)
        # The two spaces have no observation, so they come back UNKNOWN, never FREE.
        assert (summary["free"], summary["unknown"], summary["closed"]) == (5, 5, 0)
        assert (summary["total"], summary["openPercent"]) == (20, 25)
        assert {states(client, lot_id)[sid][0] for sid in ids[18:]} == {"UNKNOWN"}
    assert states(client, lot_id)[ids[0]][0] == FREE
