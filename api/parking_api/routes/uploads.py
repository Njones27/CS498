"""Admin upload slot + completion (HDD §4.1 steps 1-3, §4.3 duplicates)."""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import AdaptersDep, AdminDep, SettingsDep, error
from ..schemas import ErrorResponse, UploadCompleteResponse, UploadRequest, UploadSlot

router = APIRouter(prefix="/admin/uploads", tags=["admin"])

NOT_IMPLEMENTED = error(501, "not_implemented", "Contract stub")


@router.post(
    "",
    response_model=UploadSlot,
    status_code=201,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        409: {"model": ErrorResponse, "description": "duplicate: same bytes already uploaded"},
        422: {
            "model": ErrorResponse,
            "description": "future_capture_time | unsupported_type | too_large | unknown_viewpoint",
        },
    },
    summary="Request an upload slot; returns a presigned PUT URL",
)
def request_upload(
    body: UploadRequest, admin: AdminDep, adapters: AdaptersDep, settings: SettingsDep
) -> UploadSlot:
    raise NOT_IMPLEMENTED


@router.post(
    "/{image_id}/complete",
    response_model=UploadCompleteResponse,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse, "description": "not_pending"},
        410: {"model": ErrorResponse, "description": "expired"},
    },
    summary="Confirm the file arrived and queue the job",
)
def complete_upload(
    image_id: str, admin: AdminDep, adapters: AdaptersDep
) -> UploadCompleteResponse:
    raise NOT_IMPLEMENTED
