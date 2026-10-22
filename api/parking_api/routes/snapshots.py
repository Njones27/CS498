"""Admin snapshot list, detail and retry (US-06)."""

from __future__ import annotations

from fastapi import APIRouter, Query

from ..deps import AdaptersDep, AdminDep, error
from ..schemas import ErrorResponse, SnapshotDetail, SnapshotOut

router = APIRouter(prefix="/admin/snapshots", tags=["admin"])

NOT_IMPLEMENTED = error(501, "not_implemented", "Contract stub")


@router.get(
    "",
    response_model=list[SnapshotOut],
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
    summary="Recent snapshots for a lot, newest capture first",
)
def list_snapshots(
    admin: AdminDep,
    adapters: AdaptersDep,
    lot_id: str = Query(alias="lotId"),
    limit: int = Query(50, ge=1, le=200),
) -> list[SnapshotOut]:
    raise NOT_IMPLEMENTED


@router.get(
    "/{image_id}",
    response_model=SnapshotDetail,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
    summary="One snapshot with its observations",
)
def get_snapshot(image_id: str, admin: AdminDep, adapters: AdaptersDep) -> SnapshotDetail:
    raise NOT_IMPLEMENTED


@router.post(
    "/{image_id}/retry",
    response_model=SnapshotOut,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        409: {
            "model": ErrorResponse,
            "description": "not_retryable: job not finished or not FAILED",
        },
    },
    summary="Requeue a finished, failed job",
)
def retry_snapshot(image_id: str, admin: AdminDep, adapters: AdaptersDep) -> SnapshotOut:
    raise NOT_IMPLEMENTED
