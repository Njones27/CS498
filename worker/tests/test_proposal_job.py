"""The layout proposer job: claim, run, store, retries (HDD §4.6)."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from parking_core.adapters.memory import build_memory_adapters
from parking_core.errors import PermanentJobError
from parking_core.models import (
    Cutoffs,
    Lot,
    ProposalJobMessage,
    ProposalRun,
    ProposalStatus,
    ProposedStall,
    Rect,
    Viewpoint,
)
from parking_core.settings import Adapters, Settings
from parking_worker.aligners.identity import IdentityAligner
from parking_worker.handler import EXHAUSTED_ERROR, MAX_ATTEMPTS
from parking_worker.poller import run_once
from parking_worker.proposals import (
    NO_PROPOSER,
    PHOTO_CHANGED,
    PHOTO_MISSING,
    is_proposal_message,
    process_proposal,
)
from parking_worker.scorers import StubScorer

T0 = datetime(2026, 10, 30, 12, 0, tzinfo=UTC)
KEY = "reference/L/V1/abc123def456"
STALL = ProposedStall(
    polygon=[(0.1, 0.1), (0.2, 0.1), (0.2, 0.3), (0.1, 0.3)],
    evidence=0.7,
    row=0,
    col=0,
    map_rect=Rect(x=0, y=0, w=0.1, h=0.2),
)


class FakeProposer:
    model_version = "fake-proposer"

    def __init__(self, result: list[ProposedStall] | Exception | None = None) -> None:
        self.result = [STALL] if result is None else result
        self.photos: list[bytes] = []

    def propose(self, image: bytes) -> list[ProposedStall]:
        self.photos.append(image)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def adapters() -> Adapters:
    a = build_memory_adapters(Settings(app_env="test", _env_file=None))  # type: ignore[call-arg]
    a.repository.put_lot(Lot(lot_id="L", name="Lot", created_at=T0))
    a.repository.put_viewpoint(
        Viewpoint(lot_id="L", view_id="V1", name="North", reference_image_key=KEY)
    )
    a.object_store.put(KEY, b"photo-bytes", "image/jpeg")
    return a


def queue_run(adapters: Adapters, run_id: str = "r1", key: str = KEY) -> None:
    adapters.repository.put_proposal_run(
        ProposalRun(
            lot_id="L",
            view_id="V1",
            run_id=run_id,
            reference_image_key=key,
            requested_by="admin@example.edu",
            requested_at=T0,
        )
    )
    adapters.queue.send(
        ProposalJobMessage(lot_id="L", view_id="V1", run_id=run_id).model_dump_json()
    )


def receive(adapters: Adapters):
    (msg,) = adapters.queue.receive(max_messages=1, wait_seconds=0)
    return msg


def stored(adapters: Adapters) -> ProposalRun:
    run = adapters.repository.get_proposal_run("L", "V1")
    assert run is not None
    return run


def test_is_proposal_message():
    assert is_proposal_message(
        ProposalJobMessage(lot_id="L", view_id="V", run_id="r").model_dump_json()
    )
    assert not is_proposal_message(json.dumps({"imageId": "i1"}))
    assert not is_proposal_message("not json")
    assert not is_proposal_message("[1, 2]")


def test_proposal_job_stores_stalls(adapters):
    queue_run(adapters)
    proposer = FakeProposer()
    result = process_proposal(receive(adapters), adapters, proposer, now=lambda: T0)
    assert result.outcome == "completed" and result.stalls == 1
    assert proposer.photos == [b"photo-bytes"]
    run = stored(adapters)
    assert run.status == ProposalStatus.COMPLETE
    assert run.proposals == [STALL]
    assert run.model_version == "fake-proposer" and run.completed_at == T0 and run.attempts == 1
    assert adapters.queue.receive(max_messages=1, wait_seconds=0) == []  # message deleted


def test_poller_routes_proposal_jobs(adapters):
    queue_run(adapters)
    result = run_once(
        adapters,
        IdentityAligner(),
        StubScorer(),
        Cutoffs(),
        wait_seconds=0,
        proposer=FakeProposer(),
    )
    assert result is not None and result.outcome == "completed"
    assert stored(adapters).status == ProposalStatus.COMPLETE


def test_worker_without_proposer_fails_the_run(adapters):
    queue_run(adapters)
    result = run_once(adapters, IdentityAligner(), StubScorer(), Cutoffs(), wait_seconds=0)
    assert result is not None and result.error == NO_PROPOSER
    assert stored(adapters).status == ProposalStatus.FAILED


def test_changed_reference_photo_fails_permanently(adapters):
    queue_run(adapters, key="reference/L/V1/older0000000")
    proposer = FakeProposer()
    result = process_proposal(receive(adapters), adapters, proposer)
    assert result.outcome == "failed_permanent" and result.error == PHOTO_CHANGED
    assert proposer.photos == []
    run = stored(adapters)
    assert run.status == ProposalStatus.FAILED and run.error == PHOTO_CHANGED


def test_missing_reference_object_fails_permanently(adapters):
    gone = "reference/L/V1/000000000000"
    adapters.repository.update_viewpoint("L", "V1", reference_image_key=gone)
    queue_run(adapters, key=gone)
    result = process_proposal(receive(adapters), adapters, FakeProposer())
    assert result.error == PHOTO_MISSING and stored(adapters).status == ProposalStatus.FAILED


def test_unreadable_photo_fails_permanently(adapters):
    queue_run(adapters)
    proposer = FakeProposer(PermanentJobError("Could not read the photo"))
    result = process_proposal(receive(adapters), adapters, proposer)
    assert result.outcome == "failed_permanent"
    assert stored(adapters).error == "Could not read the photo"


def test_retryable_failure_then_exhausted(adapters):
    queue_run(adapters)
    proposer = FakeProposer(RuntimeError("boom"))
    for attempt in range(1, MAX_ATTEMPTS):
        msg = receive(adapters)
        assert msg.receive_count == attempt
        assert process_proposal(msg, adapters, proposer).outcome == "failed_retryable"
        run = stored(adapters)
        assert run.status == ProposalStatus.PROCESSING and run.error == "boom"
        adapters.queue.requeue_inflight()  # the visibility timeout ran out: redelivered
    result = process_proposal(receive(adapters), adapters, proposer)
    assert result.outcome == "failed_exhausted"
    run = stored(adapters)
    assert run.status == ProposalStatus.FAILED and run.error == EXHAUSTED_ERROR
    assert run.attempts == MAX_ATTEMPTS


def test_replaced_run_is_skipped(adapters):
    queue_run(adapters, "r1")
    old = receive(adapters)
    queue_run(adapters, "r2")  # a newer request replaced r1
    proposer = FakeProposer()
    assert process_proposal(old, adapters, proposer).outcome == "skipped"
    assert proposer.photos == []
    assert stored(adapters).status == ProposalStatus.QUEUED


def test_finished_run_is_skipped(adapters):
    queue_run(adapters)
    msg = receive(adapters)
    assert process_proposal(msg, adapters, FakeProposer()).outcome == "completed"
    assert process_proposal(msg, adapters, FakeProposer()).outcome == "skipped"


def test_malformed_proposal_message_is_dropped(adapters):
    adapters.queue.send(json.dumps({"kind": "propose", "lotId": "L"}))
    result = process_proposal(receive(adapters), adapters, FakeProposer())
    assert result.outcome == "failed_permanent"
    assert adapters.queue.receive(max_messages=1, wait_seconds=0) == []
