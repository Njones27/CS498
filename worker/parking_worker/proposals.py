"""Process one layout proposer job (HDD §4.6): read a viewpoint's reference photo, propose
stall outlines, store them on the viewpoint's latest `ProposalRun`. Pure, like `handler.py`,
so the Phase 2 Lambda handler can reuse it.

The run record carries the job state. Retries follow `handler.py`: a retryable failure leaves
the run PROCESSING with its error and the message on the queue for redelivery; the last attempt
or a permanent error marks it FAILED.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from parking_core.errors import PermanentJobError
from parking_core.interfaces import LayoutProposer
from parking_core.models import Message, ProposalJobMessage, ProposalRun, ProposalStatus, utcnow
from parking_core.settings import Adapters
from pydantic import ValidationError

from .handler import EXHAUSTED_ERROR, MAX_ATTEMPTS, Outcome

log = logging.getLogger(__name__)

PHOTO_CHANGED = "The reference photo changed; run it again"
NO_PHOTO = "This viewpoint has no reference photo"
PHOTO_MISSING = "The reference photo is missing from storage"
NO_VIEWPOINT = "Viewpoint not found"
NO_PROPOSER = "This worker cannot propose layouts"

# A run may be (re)claimed from these. PROCESSING covers a redelivered message after a worker
# died mid-run, or a retry after a retryable failure.
_CLAIMABLE = {ProposalStatus.QUEUED, ProposalStatus.PROCESSING}
_DONE = {ProposalStatus.COMPLETE, ProposalStatus.FAILED}


@dataclass
class ProposalResult:
    run_id: str | None
    outcome: Outcome
    error: str | None = None
    stalls: int = 0


def is_proposal_message(body: str) -> bool:
    """True for a `ProposalJobMessage` body. Score jobs (`JobMessage`) carry no `kind`."""
    try:
        data = json.loads(body)
    except ValueError:
        return False
    return isinstance(data, dict) and data.get("kind") == "propose"


def process_proposal(
    msg: Message,
    adapters: Adapters,
    proposer: LayoutProposer | None,
    now: Callable[[], datetime] = utcnow,
) -> ProposalResult:
    repo = adapters.repository
    try:
        job = ProposalJobMessage.model_validate_json(msg.body)
    except ValidationError:
        log.error("Dropping malformed proposal message: %r", msg.body[:200])
        adapters.queue.delete(msg.receipt)
        return ProposalResult(None, "failed_permanent", "Malformed job message")

    run = repo.get_proposal_run(job.lot_id, job.view_id)
    if run is None or run.run_id != job.run_id or run.status in _DONE:
        log.info("Proposal run %s finished, replaced or unknown; skipping", job.run_id)
        adapters.queue.delete(msg.receipt)
        return ProposalResult(job.run_id, "skipped")
    claimed = repo.transition_proposal_run(
        job.lot_id,
        job.view_id,
        job.run_id,
        _CLAIMABLE,
        ProposalStatus.PROCESSING,
        attempts=msg.receive_count,
    )
    if not claimed:
        return ProposalResult(job.run_id, "deferred")

    def finish(status: ProposalStatus, **fields: object) -> bool:
        return repo.transition_proposal_run(
            job.lot_id, job.view_id, job.run_id, {ProposalStatus.PROCESSING}, status, **fields
        )

    started = time.monotonic()
    try:
        if proposer is None:
            raise PermanentJobError(NO_PROPOSER)
        photo = _reference_photo(adapters, run)
        stalls = proposer.propose(photo)
    except PermanentJobError as exc:
        log.warning("Proposal run %s failed permanently: %s", job.run_id, exc)
        moved = finish(ProposalStatus.FAILED, error=str(exc), completed_at=now())
        _settle(adapters, msg, job, moved)
        return ProposalResult(job.run_id, "failed_permanent", str(exc))
    except Exception as exc:
        if msg.receive_count >= MAX_ATTEMPTS:
            log.exception("Proposal run %s exhausted retries; last error: %s", job.run_id, exc)
            moved = finish(ProposalStatus.FAILED, error=EXHAUSTED_ERROR, completed_at=now())
            _settle(adapters, msg, job, moved)
            return ProposalResult(job.run_id, "failed_exhausted", EXHAUSTED_ERROR)
        log.warning("Proposal run %s attempt %d failed: %s", job.run_id, msg.receive_count, exc)
        finish(ProposalStatus.PROCESSING, error=str(exc))
        return ProposalResult(job.run_id, "failed_retryable", str(exc))

    moved = finish(
        ProposalStatus.COMPLETE,
        error=None,
        completed_at=now(),
        model_version=proposer.model_version,
        proposals=stalls,
    )
    if not moved:
        log.warning("Proposal run %s changed under us; COMPLETE rejected", job.run_id)
    _settle(adapters, msg, job, moved)
    log.info(
        "Proposal run %s complete: %d stalls in %.1f s",
        job.run_id,
        len(stalls),
        time.monotonic() - started,
    )
    return ProposalResult(job.run_id, "completed", stalls=len(stalls))


def _reference_photo(adapters: Adapters, run: ProposalRun) -> bytes:
    """The photo the run was asked for, as long as it is still the viewpoint's photo."""
    view = adapters.repository.get_viewpoint(run.lot_id, run.view_id)
    if view is None:
        raise PermanentJobError(NO_VIEWPOINT)
    if view.reference_image_key is None:
        raise PermanentJobError(NO_PHOTO)
    if view.reference_image_key != run.reference_image_key:
        raise PermanentJobError(PHOTO_CHANGED)
    try:
        return adapters.object_store.get(view.reference_image_key)
    except KeyError as exc:
        raise PermanentJobError(PHOTO_MISSING) from exc


def _settle(adapters: Adapters, msg: Message, job: ProposalJobMessage, transitioned: bool) -> None:
    """Delete the message once the run is finished. If our final transition lost a race,
    keep the message unless the run is gone, replaced or finished by someone else."""
    if transitioned:
        adapters.queue.delete(msg.receipt)
        return
    run = adapters.repository.get_proposal_run(job.lot_id, job.view_id)
    if run is None or run.run_id != job.run_id or run.status in _DONE:
        adapters.queue.delete(msg.receipt)
