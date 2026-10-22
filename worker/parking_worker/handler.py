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
    "completed", "skipped", "failed_permanent", "failed_retryable", "failed_exhausted"
]

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

    if not _claim(adapters, image_id):
        log.info("Job %s already finished or unknown; skipping", image_id)
        adapters.queue.delete(msg.receipt)
        return ProcessResult(image_id, "skipped")

    started = time.monotonic()
    try:
        written, layout_version = _run(image_id, adapters, aligner, scorer, cutoffs)
    except PermanentJobError as exc:
        log.warning("Job %s failed permanently: %s", image_id, exc)
        repo.transition_job(
            image_id,
            {JobStatus.PROCESSING},
            JobStatus.FAILED,
            finished=True,
            error=str(exc),
            attempts=msg.receive_count,
            completed_at=now(),
        )
        adapters.queue.delete(msg.receipt)
        return ProcessResult(image_id, "failed_permanent", str(exc))
    except Exception as exc:
        if msg.receive_count >= MAX_ATTEMPTS:
            log.exception("Job %s exhausted retries; last error: %s", image_id, exc)
            repo.transition_job(
                image_id,
                {JobStatus.PROCESSING},
                JobStatus.FAILED,
                finished=True,
                error=EXHAUSTED_ERROR,
                attempts=msg.receive_count,
                completed_at=now(),
            )
            adapters.queue.delete(msg.receipt)
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

    repo.transition_job(
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
    adapters.queue.delete(msg.receipt)
    log.info("Job %s complete: %d spaces", image_id, written)
    return ProcessResult(image_id, "completed", spaces_written=written)


def _claim(adapters: Adapters, image_id: str) -> bool:
    """Move the job to PROCESSING unless it is finished or unknown.

    A redelivered message for a job stuck in PROCESSING (worker died) is re-claimed.
    """
    snapshot = adapters.repository.get_snapshot(image_id)
    if snapshot is None or snapshot.finished:
        return False
    return adapters.repository.transition_job(image_id, _CLAIMABLE, JobStatus.PROCESSING)


def _run(
    image_id: str,
    adapters: Adapters,
    aligner: Aligner,
    scorer: SpaceScorer,
    cutoffs: Cutoffs,
) -> tuple[int, int]:
    """Score one photo and write observations/statuses. Returns (spaces, layout version)."""
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

    observations: list[SpaceObservation] = []
    statuses: list[SpaceStatus] = []
    for score in scores:
        state = decide_state(score.acpds_score, score.car_overlap, score.in_frame, cutoffs)
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
    return len(observations), layout.version


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
