"""Layout proposer endpoints (HDD §4.6): request a run, poll it, review the stalls."""

from __future__ import annotations

from datetime import timedelta

import pytest
from parking_core.models import ProposalStatus, ProposedStall, Rect, Viewpoint
from parking_worker.aligners.identity import IdentityAligner
from parking_worker.poller import run_once
from parking_worker.scorers import StubScorer

from .conftest import NOW, token

URL = "/admin/lots/test-lot/views/V1/proposals"

ROUTES = [("post", URL, {}), ("get", URL, {})]

STALL = ProposedStall(
    polygon=[(0.1, 0.1), (0.2, 0.1), (0.2, 0.3), (0.1, 0.3)],
    evidence=0.4,
    row=0,
    col=0,
    map_rect=Rect(x=0, y=0, w=0.1, h=0.2),
)


class FakeProposer:
    model_version = "fake-proposer"

    def propose(self, image: bytes) -> list[ProposedStall]:
        return [STALL]


def work(adapters, settings, proposer=None):
    return run_once(
        adapters,
        IdentityAligner(),
        StubScorer(),
        settings.cutoffs,
        wait_seconds=0,
        proposer=proposer or FakeProposer(),
    )


@pytest.mark.parametrize(("method", "path", "kw"), ROUTES)
def test_proposal_routes_require_admin(client, viewer_headers, settings, method, path, kw):
    assert getattr(client, method)(path, **kw).status_code == 401
    r = getattr(client, method)(path, headers=viewer_headers, **kw)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    old = token(settings, settings.dev_admin_email, ["admin"], now=NOW - timedelta(days=1))
    r = getattr(client, method)(path, headers={"Authorization": f"Bearer {old}"}, **kw)
    assert r.status_code == 401 and r.json()["error"] == "session_expired"


def test_find_stalls_queues_then_completes(client, admin_headers, adapters, settings):
    r = client.post(URL, headers=admin_headers)
    assert r.status_code == 202, r.text
    queued = r.json()
    assert queued["status"] == "QUEUED" and queued["stalls"] == []
    assert queued["requestedBy"] == settings.dev_admin_email and queued["photoChanged"] is False

    polled = client.get(URL, headers=admin_headers).json()
    assert polled["runId"] == queued["runId"] and polled["status"] == "QUEUED"

    result = work(adapters, settings)
    assert result is not None and result.outcome == "completed"
    done = client.get(URL, headers=admin_headers).json()
    assert done["status"] == "COMPLETE" and done["modelVersion"] == "fake-proposer"
    assert done["stalls"] == [STALL.model_dump(mode="json", by_alias=True)]


def test_second_request_while_running_is_refused(client, admin_headers, clock):
    first = client.post(URL, headers=admin_headers).json()
    r = client.post(URL, headers=admin_headers)
    assert r.status_code == 409
    assert r.json()["error"] == "proposal_running" and r.json()["runId"] == first["runId"]
    # A run stuck past the limit (worker down) may be replaced.
    clock.now = NOW + timedelta(minutes=6)
    r = client.post(URL, headers=admin_headers)
    assert r.status_code == 202 and r.json()["runId"] != first["runId"]


def test_finished_run_can_be_rerun(client, admin_headers, adapters, settings):
    client.post(URL, headers=admin_headers)
    work(adapters, settings)
    assert client.post(URL, headers=admin_headers).status_code == 202


def test_replaced_run_never_overwrites_the_new_one(
    client, admin_headers, adapters, settings, clock
):
    client.post(URL, headers=admin_headers)
    clock.now = NOW + timedelta(minutes=6)
    newer = client.post(URL, headers=admin_headers).json()
    first = work(adapters, settings)  # the stale message
    assert first is not None and first.outcome == "skipped"
    second = work(adapters, settings)
    assert second is not None and second.run_id == newer["runId"]
    assert client.get(URL, headers=admin_headers).json()["status"] == "COMPLETE"


def test_no_reference_photo(client, admin_headers, adapters):
    adapters.repository.put_viewpoint(Viewpoint(lot_id="draft", view_id="V1", name="North"))
    r = client.post("/admin/lots/draft/views/V1/proposals", headers=admin_headers)
    assert r.status_code == 409
    assert r.json() == {"error": "no_reference_photo", "message": "Upload a reference photo first"}


@pytest.mark.parametrize(
    "path",
    ["/admin/lots/nope/views/V1/proposals", "/admin/lots/test-lot/views/V9/proposals"],
)
def test_unknown_lot_or_view(client, admin_headers, path):
    assert client.post(path, headers=admin_headers).status_code == 404
    assert client.get(path, headers=admin_headers).status_code == 404


def test_no_run_yet(client, admin_headers):
    r = client.get(URL, headers=admin_headers)
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_photo_changed_after_request(client, admin_headers, adapters, settings):
    client.post(URL, headers=admin_headers)
    adapters.repository.update_viewpoint("test-lot", "V1", reference_image_key="reference/x/V1/new")
    assert client.get(URL, headers=admin_headers).json()["photoChanged"] is True
    work(adapters, settings)
    done = client.get(URL, headers=admin_headers).json()
    assert done["status"] == "FAILED"
    assert done["error"] == "The reference photo changed; run it again"


def test_queue_failure_marks_the_run_failed(client, admin_headers, adapters, monkeypatch):
    def broken(body: str) -> None:
        raise RuntimeError("queue down")

    monkeypatch.setattr(adapters.queue, "send", broken)
    with pytest.raises(RuntimeError):
        client.post(URL, headers=admin_headers)
    run = adapters.repository.get_proposal_run("test-lot", "V1")
    assert run is not None and run.status == ProposalStatus.FAILED
    assert run.error == "Could not queue job"


def test_proposed_outline_evidence_survives_a_draft_save(client, admin_headers):
    draft = client.get("/admin/lots/test-lot/layout/draft", headers=admin_headers).json()
    v1 = next(v for v in draft["viewpoints"] if v["viewId"] == "V1")
    sid = next(iter(v1["outlines"]))
    found = {"source": "proposed", "status": "pending", "evidence": 0.35, "newSpace": True}
    v1["outlineReview"][sid] = found
    body = {k: v for k, v in draft.items() if k not in {"updatedAt", "updatedBy"}}
    for v in body["viewpoints"]:
        v.pop("referenceImage", None)
    r = client.put("/admin/lots/test-lot/layout/draft", json=body, headers=admin_headers)
    assert r.status_code == 200, r.text
    again = client.get("/admin/lots/test-lot/layout/draft", headers=admin_headers).json()
    review = next(v for v in again["viewpoints"] if v["viewId"] == "V1")["outlineReview"]
    assert review[sid] == found
    # Reviews without them (drawn outlines) carry no evidence or newSpace key at all.
    assert all("evidence" not in r and "newSpace" not in r for s, r in review.items() if s != sid)
    # And the pending proposal blocks publishing until reviewed.
    report = client.post("/admin/lots/test-lot/layout/draft/validate", headers=admin_headers).json()
    assert any(e["code"] == "pending_proposals" for e in report["errors"])
