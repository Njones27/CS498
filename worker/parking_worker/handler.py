"""Process one queue message (HDD §4.1-4.2). Pure: reused by the Phase 2 Lambda handler."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from parking_core.errors import NotPublishedError, PermanentJobError
from parking_core.interfaces import Aligner, SpaceScorer
from parking_core.keys import layout_snapshot_key
from parking_core.models import (
    CarBox,
    Cutoffs,
    JobMessage,
    JobStatus,
    Message,
    PublishedLayout,
    Snapshot,
    SpaceObservation,
    SpaceStatus,
    utcnow,
)
from parking_core.settings import Adapters
from parking_core.state_rules import decide_state

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
EXHAUSTED_ERROR = f"Failed after {MAX_ATTEMPTS} attempts"

Outcome = Literal[
    "completed",
    "skipped",
    "deferred",
    "failed_permanent",
    "failed_retryable",
    "failed_exhausted",
]
"""`skipped`: the job is finished or unknown, message dropped. `deferred`: the job exists but
could not be claimed (not queued yet, or another worker holds it); message left for redelivery."""

# A job may be (re)claimed from these states. FAILED is included only for jobs that
# are not finished (a retryable failure awaiting redelivery); see `_claim`.
_CLAIMABLE = {JobStatus.QUEUED, JobStatus.PROCESSING, JobStatus.FAILED}


@dataclass
class ProcessResult:
    image_id: str | None
    outcome: Outcome
    error: str | None = None
    spaces_written: int = 0


def process_message(
    msg: Message,
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
    now: Callable[[], datetime] = utcnow,
) -> ProcessResult:
    repo = adapters.repository
    try:
        image_id = JobMessage.model_validate_json(msg.body).image_id
    except ValueError:
        log.error("Dropping malformed job message: %r", msg.body[:200])
        adapters.queue.delete(msg.receipt)
        return ProcessResult(None, "failed_permanent", "Malformed job message")

    claim = _claim(adapters, image_id)
    if claim == "skip":
        log.info("Job %s already finished or unknown; skipping", image_id)
        adapters.queue.delete(msg.receipt)
        return ProcessResult(image_id, "skipped")
    if claim == "defer":
        log.info("Job %s not claimable right now; leaving message for redelivery", image_id)
        return ProcessResult(image_id, "deferred")

    started = time.monotonic()
    try:
        written, layout_version, detections = _run(image_id, adapters, aligner, scorer, cutoffs)
    except PermanentJobError as exc:
        log.warning("Job %s failed permanently: %s", image_id, exc)
        moved = repo.transition_job(
            image_id,
            {JobStatus.PROCESSING},
            JobStatus.FAILED,
            finished=True,
            error=str(exc),
            attempts=msg.receive_count,
            completed_at=now(),
        )
        _settle(adapters, msg, image_id, moved)
        return ProcessResult(image_id, "failed_permanent", str(exc))
    except Exception as exc:
        if msg.receive_count >= MAX_ATTEMPTS:
            log.exception("Job %s exhausted retries; last error: %s", image_id, exc)
            moved = repo.transition_job(
                image_id,
                {JobStatus.PROCESSING},
                JobStatus.FAILED,
                finished=True,
                error=EXHAUSTED_ERROR,
                attempts=msg.receive_count,
                completed_at=now(),
            )
            _settle(adapters, msg, image_id, moved)
            return ProcessResult(image_id, "failed_exhausted", EXHAUSTED_ERROR)
        log.warning("Job %s attempt %d failed, will retry: %s", image_id, msg.receive_count, exc)
        repo.transition_job(
            image_id,
            {JobStatus.PROCESSING},
            JobStatus.FAILED,
            finished=False,
            error=str(exc),
            attempts=msg.receive_count,
        )
        return ProcessResult(image_id, "failed_retryable", str(exc))

    repo.put_detections(image_id, detections)  # overlay debug data; an overwrite, so idempotent
    moved = repo.transition_job(
        image_id,
        {JobStatus.PROCESSING},
        JobStatus.COMPLETE,
        finished=True,
        error=None,
        attempts=msg.receive_count,
        completed_at=now(),
        processing_ms=int((time.monotonic() - started) * 1000),
        model_version=scorer.model_version,
        layout_version=layout_version,
    )
    if not moved:
        # Another worker changed the job while we ran (visibility timeout expired). Our
        # observation/status writes were idempotent and conditional, so nothing is lost.
        log.warning("Job %s changed under us; final COMPLETE transition rejected", image_id)
    _settle(adapters, msg, image_id, moved)
    log.info("Job %s complete: %d spaces", image_id, written)
    return ProcessResult(image_id, "completed", spaces_written=written)


def _settle(adapters: Adapters, msg: Message, image_id: str, transitioned: bool) -> None:
    """Delete the message once the job is finished. If our final transition lost a race,
    re-read the job and keep the message unless someone else finished it."""
    if transitioned:
        adapters.queue.delete(msg.receipt)
        return
    snapshot = adapters.repository.get_snapshot(image_id)
    if snapshot is None or snapshot.finished:
        adapters.queue.delete(msg.receipt)


def _claim(adapters: Adapters, image_id: str) -> Literal["claimed", "skip", "defer"]:
    """Move the job to PROCESSING.

    "skip" when the job is unknown or already finished (drop the message); "defer" when it
    exists but is not claimable yet (still UPLOAD_PENDING, or the conditional write lost a
    race), so the message stays on the queue. A redelivered message for a job stuck in
    PROCESSING (worker died) is re-claimed.
    """
    snapshot = adapters.repository.get_snapshot(image_id)
    if snapshot is None or snapshot.finished:
        return "skip"
    if adapters.repository.transition_job(image_id, _CLAIMABLE, JobStatus.PROCESSING):
        return "claimed"
    return "defer"


def _run(
    image_id: str,
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
) -> tuple[int, int, list[CarBox]]:
    """Score one photo and write observations/statuses.

    Returns (spaces, layout version, every detection on the photo, any class)."""
    repo = adapters.repository
    snapshot = repo.get_snapshot(image_id)
    if snapshot is None:
        raise PermanentJobError("Snapshot not found")
    if repo.get_lot(snapshot.lot_id) is None:
        raise PermanentJobError("Lot not found")
    layout = _load_layout(adapters, snapshot)

    viewpoint = layout.viewpoint(snapshot.view_id)
    if viewpoint is None:
        raise PermanentJobError("Unknown viewpoint")

    if not adapters.object_store.exists(snapshot.s3_key):
        raise PermanentJobError("Photo missing from storage")
    image = adapters.object_store.get(snapshot.s3_key)

    outlines = aligner.align(image, viewpoint)  # AlignmentError is a PermanentJobError
    in_view = set(viewpoint.outlines)
    scores = [s for s in scorer.score(image, outlines) if s.space_id in in_view]
    outline_by_id = {o.space_id: o for o in outlines}

    observations: list[SpaceObservation] = []
    statuses: list[SpaceStatus] = []
    for score in scores:
        state = decide_state(score.acpds_score, score.car_overlap, score.in_frame, cutoffs)
        outline = outline_by_id.get(score.space_id)
        observations.append(
            SpaceObservation(
                image_id=image_id,
                lot_id=snapshot.lot_id,
                space_id=score.space_id,
                state=state,
                acpds_score=score.acpds_score,
                car_overlap=score.car_overlap,
                in_frame=score.in_frame,
                capture_time=snapshot.capture_time,
                polygon=outline.polygon if outline else None,
            )
        )
        statuses.append(
            SpaceStatus(
                lot_id=snapshot.lot_id,
                space_id=score.space_id,
                state=state,
                confidence=score.acpds_score,
                observed_at=snapshot.capture_time,
                source_image_id=image_id,
            )
        )

    repo.put_observations(observations)
    for status in statuses:
        repo.update_status_if_newer(status)
    return len(observations), layout.version, list(scorer.last_detections)


def _load_layout(adapters: Adapters, snapshot: Snapshot) -> PublishedLayout:
    """The layout pinned on the snapshot (a retry keeps its version), else the current one."""
    if snapshot.layout_version is not None:
        key = layout_snapshot_key(snapshot.lot_id, snapshot.layout_version)
        if adapters.object_store.exists(key):
            return PublishedLayout.model_validate_json(adapters.object_store.get(key))
    try:
        layout = adapters.repository.get_published_layout(snapshot.lot_id)
    except NotPublishedError:
        layout = None
    if layout is None:
        raise PermanentJobError("Lot has no published layout")
    return layout
