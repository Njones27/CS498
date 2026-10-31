"""Layout proposer endpoints (HDD §4.6): propose stall outlines from a viewpoint's reference
photo. The worker does the work; the mapping page polls the run, merges the stalls into its
draft as pending proposed outlines, and saves the draft as usual."""

from __future__ import annotations

import logging
import uuid
from datetime import timedelta

from fastapi import APIRouter
from parking_core.models import ProposalJobMessage, ProposalRun, ProposalStatus, Viewpoint

from ..deps import AdaptersDep, AdminDep, NowDep, error
from ..proposals_schemas import ProposalRunOut
from ..schemas import ErrorResponse

log = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/lots/{lot_id}/views/{view_id}/proposals", tags=["admin"])

_AUTH = {401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}}

RUN_STALE_AFTER = timedelta(minutes=5)
"""A run still queued or processing after this long is taken as lost (worker down), so a new
request may replace it. A worker that later finishes it can no longer write: the run id moved."""

QUEUE_SEND_FAILED = "Could not queue job"


def _viewpoint(adapters: AdaptersDep, lot_id: str, view_id: str) -> Viewpoint:
    repo = adapters.repository
    if repo.get_lot(lot_id) is None:
        raise error(404, "not_found", "Lot not found")
    view = repo.get_viewpoint(lot_id, view_id)
    if view is None:
        raise error(404, "not_found", "Viewpoint not found")
    return view


def _out(run: ProposalRun, view: Viewpoint) -> ProposalRunOut:
    return ProposalRunOut(
        run_id=run.run_id,
        lot_id=run.lot_id,
        view_id=run.view_id,
        status=run.status,
        requested_by=run.requested_by,
        requested_at=run.requested_at,
        completed_at=run.completed_at,
        error=run.error,
        model_version=run.model_version,
        photo_changed=view.reference_image_key != run.reference_image_key,
        stalls=run.proposals if run.status == ProposalStatus.COMPLETE else [],
    )


@router.post(
    "",
    response_model=ProposalRunOut,
    status_code=202,
    responses={
        **_AUTH,
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse, "description": "no_reference_photo | proposal_running"},
    },
    summary="Find stalls on the viewpoint's reference photo (queues a layout proposer run)",
)
def request_proposals(
    lot_id: str, view_id: str, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> ProposalRunOut:
    repo = adapters.repository
    view = _viewpoint(adapters, lot_id, view_id)
    if view.reference_image_key is None:
        raise error(409, "no_reference_photo", "Upload a reference photo first")
    current = repo.get_proposal_run(lot_id, view_id)
    if (
        current is not None
        and current.status in {ProposalStatus.QUEUED, ProposalStatus.PROCESSING}
        and now - current.requested_at < RUN_STALE_AFTER
    ):
        raise error(
            409, "proposal_running", "Already finding stalls on this photo", runId=current.run_id
        )
    run = ProposalRun(
        lot_id=lot_id,
        view_id=view_id,
        run_id=uuid.uuid4().hex,
        reference_image_key=view.reference_image_key,
        requested_by=admin.email,
        requested_at=now,
    )
    repo.put_proposal_run(run)
    try:
        adapters.queue.send(
            ProposalJobMessage(lot_id=lot_id, view_id=view_id, run_id=run.run_id).model_dump_json()
        )
    except Exception:
        log.exception("queue send failed", extra={"run_id": run.run_id})
        repo.transition_proposal_run(
            lot_id,
            view_id,
            run.run_id,
            {ProposalStatus.QUEUED},
            ProposalStatus.FAILED,
            error=QUEUE_SEND_FAILED,
            completed_at=now,
        )
        raise
    return _out(run, view)


@router.get(
    "",
    response_model=ProposalRunOut,
    responses={**_AUTH, 404: {"model": ErrorResponse}},
    summary="The latest layout proposer run on this viewpoint, with its stalls once complete",
)
def get_proposals(
    lot_id: str, view_id: str, admin: AdminDep, adapters: AdaptersDep
) -> ProposalRunOut:
    view = _viewpoint(adapters, lot_id, view_id)
    run = adapters.repository.get_proposal_run(lot_id, view_id)
    if run is None:
        raise error(404, "not_found", "No stalls have been proposed for this viewpoint")
    return _out(run, view)
