"""Queueing a snapshot job, shared by upload completion and retry."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from parking_core.models import JobMessage, JobStatus, Snapshot
from parking_core.settings import Adapters

log = logging.getLogger(__name__)

QUEUE_SEND_FAILED = "Could not queue job"


def enqueue_job(adapters: Adapters, image_id: str) -> None:
    """Send the job message for a snapshot already moved to QUEUED.

    If the send fails, the job would sit QUEUED with no message behind it, and Retry only
    accepts finished FAILED jobs. So mark it FAILED/finished (retryable) and re-raise.
    """
    try:
        adapters.queue.send(JobMessage(image_id=image_id).model_dump_json())
    except Exception:
        log.exception("queue send failed", extra={"image_id": image_id})
        adapters.repository.transition_job(
            image_id,
            {JobStatus.QUEUED},
            JobStatus.FAILED,
            finished=True,
            error=QUEUE_SEND_FAILED,
        )
        raise


def rescore_latest(
    adapters: Adapters, lot_id: str, version: int, by: str, now: datetime
) -> list[str]:
    """After publishing `version`: score each viewpoint's latest processed photo again, against
    that version, so spaces new in it get a state without another upload (HDD §4.6).

    The re-score is a new snapshot of the same stored photo and capture time, pinned to
    `version`; the original keeps the version it was processed with (US-09 #5). The duplicate
    check is for uploads and is not involved. Best effort: a failure is logged, and the
    publish it follows stands. Returns the new snapshots' image ids."""
    try:
        repo = adapters.repository
        latest: dict[str, Snapshot] = {}
        current: set[str] = set()  # viewpoints already scored (or queued) with `version`
        for snap in repo.list_snapshots(lot_id):  # newest capture first
            if snap.layout_version == version:
                current.add(snap.view_id)
            if snap.job_status is JobStatus.COMPLETE and snap.view_id not in latest:
                latest[snap.view_id] = snap
        queued = []
        for view_id, snap in latest.items():
            if view_id in current:
                continue
            rescore = snap.model_copy(
                update={
                    "image_id": uuid.uuid4().hex,
                    "uploaded_by": by,
                    "job_status": JobStatus.QUEUED,
                    "attempts": 0,
                    "finished": False,
                    "error": None,
                    "model_version": None,
                    "layout_version": version,
                    "processing_ms": None,
                    "created_at": now,
                    "queued_at": now,
                    "completed_at": None,
                    "rescore_of": snap.image_id,
                }
            )
            repo.put_snapshot(rescore)
            enqueue_job(adapters, rescore.image_id)
            queued.append(rescore.image_id)
        return queued
    except Exception:
        log.exception("re-score after publish failed", extra={"lot_id": lot_id, "version": version})
        return []
