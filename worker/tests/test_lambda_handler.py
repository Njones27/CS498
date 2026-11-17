"""The Lambda entry point: SQS event records in, partial batch failures out."""

from __future__ import annotations

import json

import pytest
from conftest import LOT, T0, World
from parking_core.errors import RetryableJobError
from parking_core.models import (
    Cutoffs,
    JobStatus,
    ProposalJobMessage,
    ProposalRun,
    ProposalStatus,
    Viewpoint,
)
from parking_worker import lambda_handler
from parking_worker.aligners import IdentityAligner
from parking_worker.lambda_handler import RETRY_DELAY_SECONDS, Runtime, handle
from parking_worker.scorers import StubScorer


class FailingAligner:
    def align(self, image: bytes, viewpoint: Viewpoint):
        raise RetryableJobError("storage hiccup")


class FakeProposer:
    model_version = "fake-proposer"

    def propose(self, image: bytes):
        return []


def runtime(world: World, aligner=None, proposer=None) -> Runtime:
    return Runtime(world.adapters, aligner or IdentityAligner(), StubScorer(), proposer, Cutoffs())


def sqs_event(world: World, count: int = 1) -> dict:
    """What Lambda's SQS event source hands the function for the next `count` messages."""
    return {
        "Records": [
            {
                "messageId": f"m-{i}",
                "receiptHandle": m.receipt,
                "body": m.body,
                "attributes": {"ApproximateReceiveCount": str(m.receive_count)},
                "eventSource": "aws:sqs",
            }
            for i, m in enumerate(world.queue.receive(max_messages=count))
        ]
    }


def test_scored_photo_reports_no_failures(world: World):
    world.add_snapshot("img-1")
    assert handle(sqs_event(world), runtime(world)) == {"batchItemFailures": []}
    assert world.repo.get_snapshot("img-1").job_status is JobStatus.COMPLETE
    assert len(world.queue) == 0


def test_retryable_failure_stays_on_the_queue_and_comes_back_soon(world: World):
    world.add_snapshot("img-1")
    result = handle(sqs_event(world), runtime(world, aligner=FailingAligner()))
    assert result == {"batchItemFailures": [{"itemIdentifier": "m-0"}]}
    assert len(world.queue) == 1
    assert world.queue.receive() == []  # not yet
    world.queue.advance(RETRY_DELAY_SECONDS + 1)  # well inside the visibility timeout
    [again] = world.queue.receive()
    assert again.receive_count == 2

    # The second failure waits twice as long before the last attempt.
    event = {
        "Records": [
            {
                "messageId": "m-0",
                "receiptHandle": again.receipt,
                "body": again.body,
                "attributes": {"ApproximateReceiveCount": "2"},
            }
        ]
    }
    assert handle(event, runtime(world, aligner=FailingAligner()))["batchItemFailures"]
    world.queue.advance(RETRY_DELAY_SECONDS + 1)
    assert world.queue.receive() == []
    world.queue.advance(RETRY_DELAY_SECONDS)
    assert len(world.queue.receive()) == 1


def test_a_message_the_job_code_kept_is_not_deleted_by_lambda(world: World, monkeypatch):
    """`_settle` keeps the message when the final transition lost a race and the job is still
    unfinished. The outcome is still "completed", so the kept flag is what saves the message."""
    world.add_snapshot("img-1")
    real = world.repo.transition_job

    def lose_the_final_transition(image_id, expected, to, **fields):
        if to is JobStatus.COMPLETE:
            return False  # another worker changed the job under us
        return real(image_id, expected, to, **fields)

    monkeypatch.setattr(world.repo, "transition_job", lose_the_final_transition)
    result = handle(sqs_event(world), runtime(world))
    assert result == {"batchItemFailures": [{"itemIdentifier": "m-0"}]}
    assert len(world.queue) == 1


def test_only_the_failed_records_of_a_batch_are_reported(world: World):
    world.add_snapshot("img-ok")
    world.queue.send(json.dumps({"imageId": "img-pending"}))  # no QUEUED job yet: deferred
    world.add_snapshot("img-pending", enqueue=False)
    world.repo.transition_job("img-pending", {JobStatus.QUEUED}, JobStatus.COMPLETE, finished=False)
    world.queue.send("not json")  # malformed: dropped, never retried

    result = handle(sqs_event(world, count=3), runtime(world))
    assert result == {"batchItemFailures": [{"itemIdentifier": "m-1"}]}
    assert world.repo.get_snapshot("img-ok").job_status is JobStatus.COMPLETE
    assert len(world.queue) == 1


def test_proposal_jobs_go_to_the_proposer(world: World):
    key = f"reference/{LOT}/V1/abc"
    world.adapters.object_store.put(key, b"photo", "image/jpeg")
    world.repo.update_viewpoint(LOT, "V1", reference_image_key=key)
    world.repo.put_proposal_run(
        ProposalRun(
            lot_id=LOT,
            view_id="V1",
            run_id="r1",
            reference_image_key=key,
            requested_by="admin@example.edu",
            requested_at=T0,
        )
    )
    world.queue.send(ProposalJobMessage(lot_id=LOT, view_id="V1", run_id="r1").model_dump_json())
    result = handle(sqs_event(world), runtime(world, proposer=FakeProposer()))
    assert result == {"batchItemFailures": []}
    assert world.repo.get_proposal_run(LOT, "V1").status is ProposalStatus.COMPLETE


def test_a_crash_outside_the_job_is_retried(world: World, monkeypatch):
    world.add_snapshot("img-1")

    def boom(*args, **kwargs):
        raise RuntimeError("DynamoDB unavailable")

    monkeypatch.setattr(lambda_handler, "process_message", boom)
    result = handle(sqs_event(world), runtime(world))
    assert result == {"batchItemFailures": [{"itemIdentifier": "m-0"}]}


def test_failed_early_release_still_reports_the_failure(world: World, monkeypatch):
    world.add_snapshot("img-1")
    monkeypatch.setattr(
        world.queue, "release", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("throttled"))
    )
    result = handle(sqs_event(world), runtime(world, aligner=FailingAligner()))
    assert result == {"batchItemFailures": [{"itemIdentifier": "m-0"}]}


def test_handler_builds_the_runtime_once_from_settings(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DETECTOR", "stub")
    from parking_core.settings import get_settings

    get_settings.cache_clear()
    lambda_handler._runtime.cache_clear()
    try:
        assert lambda_handler.handler({"Records": []}, None) == {"batchItemFailures": []}
        first = lambda_handler._runtime()
        assert lambda_handler._runtime() is first
        assert first.scorer.model_version == "stub-0"
    finally:
        lambda_handler._runtime.cache_clear()
        get_settings.cache_clear()


@pytest.mark.parametrize("event", [{}, {"Records": []}])
def test_empty_events_are_fine(world: World, event):
    assert handle(event, runtime(world)) == {"batchItemFailures": []}
