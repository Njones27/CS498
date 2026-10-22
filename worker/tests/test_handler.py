from __future__ import annotations

import json
import threading
from datetime import timedelta

import pytest
from conftest import LOT, T0, V1_SPACES, World
from parking_core.errors import AlignmentError, PermanentJobError, RetryableJobError
from parking_core.models import (
    Cutoffs,
    JobStatus,
    SpaceScore,
    SpaceState,
    SpaceStatus,
    Viewpoint,
)
from parking_core.settings import Settings
from parking_worker.aligners import IdentityAligner
from parking_worker.handler import process_message
from parking_worker.poller import run_forever, run_once
from parking_worker.scorers import FakeScorer, StubScorer, build_scorer

CUTOFFS = Cutoffs()


class FailingAligner:
    def align(self, image: bytes, viewpoint: Viewpoint):
        raise AlignmentError()


def occupied_fake() -> FakeScorer:
    return FakeScorer(lambda o: SpaceScore(space_id=o.space_id, acpds_score=0.9, car_overlap=1.0))


def step(world: World, scorer=None, aligner=None, cutoffs=CUTOFFS):
    return run_once(world.adapters, aligner or IdentityAligner(), scorer or StubScorer(), cutoffs)


def statuses(world: World) -> dict[str, SpaceStatus]:
    return {s.space_id: s for s in world.repo.get_statuses(LOT)}


def test_happy_path_writes_only_this_viewpoint(world: World):
    world.add_snapshot("img-1", view_id="V1")
    result = step(world)

    assert result is not None and result.outcome == "completed"
    assert result.spaces_written == len(V1_SPACES)
    assert sorted(o.space_id for o in world.repo.list_observations("img-1")) == sorted(V1_SPACES)
    st = statuses(world)
    assert sorted(st) == sorted(V1_SPACES)  # B-02..B-04 untouched (US-11 #3)
    assert all(s.observed_at == T0 and s.source_image_id == "img-1" for s in st.values())
    assert all(s.state in (SpaceState.FREE, SpaceState.OCCUPIED) for s in st.values())

    snap = world.repo.get_snapshot("img-1")
    assert snap.job_status is JobStatus.COMPLETE
    assert snap.finished is True
    assert snap.model_version == "stub-0"
    assert snap.layout_version == 1
    assert snap.processing_ms is not None and snap.processing_ms >= 0
    assert snap.completed_at is not None
    assert len(world.queue) == 0


def test_reprocessing_same_message_is_noop(world: World):
    world.add_snapshot("img-1")
    world.queue.send(json.dumps({"imageId": "img-1"}))  # duplicate delivery
    assert step(world).outcome == "completed"
    before = statuses(world)
    obs_before = world.repo.list_observations("img-1")

    assert step(world).outcome == "skipped"
    assert statuses(world) == before
    assert world.repo.list_observations("img-1") == obs_before
    assert len(world.queue) == 0


def test_alignment_error_is_permanent(world: World):
    world.add_snapshot("img-1")
    result = step(world, aligner=FailingAligner())

    assert result.outcome == "failed_permanent"
    snap = world.repo.get_snapshot("img-1")
    assert snap.job_status is JobStatus.FAILED
    assert snap.error == "Too few matches"
    assert snap.finished is True
    assert len(world.queue) == 0
    assert world.repo.get_statuses(LOT) == []


@pytest.mark.parametrize(
    ("view_id", "error"),
    [("V9", "Unknown viewpoint")],
)
def test_unknown_viewpoint_is_permanent(world: World, view_id: str, error: str):
    world.add_snapshot("img-1", view_id=view_id)
    result = step(world)
    assert result.outcome == "failed_permanent"
    assert world.repo.get_snapshot("img-1").error == error


def test_missing_photo_is_permanent(world: World):
    snap = world.add_snapshot("img-1")
    world.repo.put_snapshot(snap.model_copy(update={"s3_key": "raw/missing.jpg"}))
    assert step(world).error == "Photo missing from storage"


def test_scorer_permanent_error(world: World):
    world.add_snapshot("img-1")
    result = step(world, scorer=FakeScorer(raise_exc=PermanentJobError("Bad photo")))
    assert result.outcome == "failed_permanent"
    assert world.repo.get_snapshot("img-1").finished is True


def test_retryable_error_keeps_message_then_exhausts(world: World):
    world.add_snapshot("img-1")
    flaky = FakeScorer(raise_exc=RetryableJobError("S3 timeout"))

    first = step(world, scorer=flaky)
    assert first.outcome == "failed_retryable"
    snap = world.repo.get_snapshot("img-1")
    assert snap.job_status is JobStatus.FAILED
    assert snap.finished is False
    assert snap.attempts == 1
    assert snap.error == "S3 timeout"
    assert len(world.queue) == 1

    world.queue.requeue_inflight()
    assert step(world, scorer=flaky).outcome == "failed_retryable"
    world.queue.requeue_inflight()
    third = step(world, scorer=flaky)
    assert third.outcome == "failed_exhausted"
    snap = world.repo.get_snapshot("img-1")
    assert snap.error == "Failed after 3 attempts"
    assert snap.finished is True
    assert snap.attempts == 3
    assert len(world.queue) == 0


def test_retry_succeeds_on_redelivery(world: World):
    world.add_snapshot("img-1")
    step(world, scorer=FakeScorer(raise_exc=RuntimeError("boom")))
    world.queue.requeue_inflight()
    result = step(world)
    assert result.outcome == "completed"
    snap = world.repo.get_snapshot("img-1")
    assert snap.job_status is JobStatus.COMPLETE and snap.error is None
    assert snap.attempts == 2


def test_stuck_processing_job_is_reclaimed(world: World):
    world.add_snapshot("img-1")
    world.repo.transition_job("img-1", {JobStatus.QUEUED}, JobStatus.PROCESSING)
    world.queue.receive()  # a worker took it and died
    world.queue.advance(60)  # visibility timeout expires

    result = step(world)
    assert result.outcome == "completed"
    assert world.repo.get_snapshot("img-1").job_status is JobStatus.COMPLETE


def test_older_photo_does_not_overwrite_newer_status(world: World):
    world.add_snapshot("new", capture_time=T0, data=b"new")
    assert step(world, scorer=occupied_fake()).outcome == "completed"

    world.add_snapshot("old", capture_time=T0 - timedelta(minutes=5), data=b"old")
    free = FakeScorer(lambda o: SpaceScore(space_id=o.space_id, acpds_score=0.05, car_overlap=0.0))
    assert step(world, scorer=free).outcome == "completed"

    st = statuses(world)
    assert all(s.source_image_id == "new" for s in st.values())
    assert all(s.state is SpaceState.OCCUPIED for s in st.values())
    old_obs = world.repo.list_observations("old")
    assert len(old_obs) == len(V1_SPACES)
    assert all(o.state is SpaceState.FREE for o in old_obs)


def test_free_requires_car_signal(world: World):
    world.add_snapshot("img-1")
    no_car = FakeScorer(
        lambda o: SpaceScore(space_id=o.space_id, acpds_score=0.05, car_overlap=None)
    )
    step(world, scorer=no_car, cutoffs=Cutoffs(require_car_check=True))
    assert all(s.state is SpaceState.UNKNOWN for s in statuses(world).values())


def test_scores_for_other_viewpoints_are_ignored(world: World):
    world.add_snapshot("img-1", view_id="V2")
    extra = FakeScorer(
        {s: SpaceScore(space_id=s, acpds_score=0.9) for s in ["A-01", "B-02", "B-03"]}
    )
    result = step(world, scorer=extra)
    assert result.spaces_written == 2
    assert sorted(statuses(world)) == ["B-02", "B-03"]


def test_unknown_job_is_skipped(world: World):
    world.queue.send(json.dumps({"imageId": "nope"}))
    assert step(world).outcome == "skipped"
    assert len(world.queue) == 0


def test_malformed_message_is_dropped(world: World):
    world.queue.send("not json")
    assert step(world).outcome == "failed_permanent"
    assert len(world.queue) == 0


def test_empty_queue_returns_none(world: World):
    assert step(world) is None


def test_process_message_direct(world: World):
    world.add_snapshot("img-1", enqueue=False)
    from parking_core.models import Message

    msg = Message(body=json.dumps({"imageId": "img-1"}), receipt="r", receive_count=1)
    result = process_message(msg, world.adapters, IdentityAligner(), StubScorer(), CUTOFFS)
    assert result.outcome == "completed"


def test_run_forever_processes_and_stops(world: World):
    world.add_snapshot("img-1")
    stop = threading.Event()
    t = threading.Thread(
        target=run_forever,
        args=(world.adapters, IdentityAligner(), StubScorer(), CUTOFFS, stop),
    )
    t.start()
    for _ in range(50):
        if world.repo.get_snapshot("img-1").job_status is JobStatus.COMPLETE:
            break
        stop.wait(0.05)
    stop.set()
    t.join(timeout=2)
    assert not t.is_alive()
    assert world.repo.get_snapshot("img-1").job_status is JobStatus.COMPLETE


def test_build_scorer():
    assert isinstance(build_scorer(Settings(app_env="test", _env_file=None)), StubScorer)
    with pytest.raises(NotImplementedError):
        build_scorer(Settings(app_env="test", detector="acpds_yolo", _env_file=None))
