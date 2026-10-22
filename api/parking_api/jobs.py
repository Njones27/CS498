"""Queueing a snapshot job, shared by upload completion and retry."""

from __future__ import annotations

import logging

from parking_core.models import JobMessage, JobStatus
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
