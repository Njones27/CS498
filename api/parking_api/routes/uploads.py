"""Admin upload slot + completion (HDD §4.1 steps 1-3, §4.3 duplicates)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from parking_core import keys
from parking_core.interfaces import Repository
from parking_core.models import EXPIRED, JobStatus, Snapshot, effective_status

from ..deps import AdaptersDep, AdminDep, NowDep, SettingsDep, error
from ..jobs import enqueue_job
from ..schemas import ErrorResponse, UploadCompleteResponse, UploadRequest, UploadSlot
from .public import require_published

router = APIRouter(prefix="/admin/uploads", tags=["admin"])
log = logging.getLogger(__name__)

_EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png"}

ORPHAN_CLAIM_GRACE = timedelta(seconds=60)
"""A hash claim with no snapshot behind it is treated as an in-flight concurrent request
for this long (claim -> put_snapshot takes milliseconds); after that it is an orphan left
by a crashed request and may be taken over."""


def _duplicate(original_image_id: str, uploaded_at: datetime) -> HTTPException:
    when = uploaded_at.strftime("%b %d, %Y at %H:%M UTC")
    return error(
        409,
        "duplicate",
        f"This photo was already uploaded on {when}",
        originalImageId=original_image_id,
        uploadedAt=uploaded_at.isoformat(),
    )


def _claim(repo: Repository, sha256: str, image_id: str, now: datetime) -> None:
    """Claim the photo hash for `image_id`, taking over an expired or orphaned claim."""
    result = repo.claim_hash(sha256, image_id, claimed_at=now)
    if not result.claimed and result.original_image_id is None:
        # The conflicting claim was released between our put and our read; try once more.
        result = repo.claim_hash(sha256, image_id, claimed_at=now)
    if result.claimed:
        return
    original_id = result.original_image_id or ""
    original = repo.get_snapshot(original_id)
    if original is None:
        claimed_at = result.claimed_at
        in_flight = claimed_at is not None and now - claimed_at < ORPHAN_CLAIM_GRACE
        if not in_flight and repo.takeover_hash(sha256, original_id, image_id, claimed_at=now):
            return
        # The winner of a concurrent claim has not written its snapshot yet.
        raise _duplicate(original_id, claimed_at or now)
    if effective_status(original, now) == EXPIRED and repo.takeover_hash(
        sha256, original_id, image_id, claimed_at=now
    ):
        return
    raise _duplicate(original_id, original.created_at)


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
    body: UploadRequest,
    admin: AdminDep,
    adapters: AdaptersDep,
    settings: SettingsDep,
    now: NowDep,
) -> UploadSlot:
    repo = adapters.repository
    lot, layout = require_published(repo, body.lot_id)
    if layout.viewpoint(body.view_id) is None:
        raise error(422, "unknown_viewpoint", "That viewpoint does not belong to this lot")
    capture_time = body.capture_time.astimezone(UTC)
    if capture_time > now:
        raise error(422, "future_capture_time", "Capture time cannot be in the future")
    if body.size_bytes > settings.max_upload_bytes:
        raise error(422, "too_large", "Photos must be 15 MB or smaller")
    if body.content_type not in settings.allowed_upload_types:
        raise error(422, "unsupported_type", "Photos must be JPEG or PNG")

    image_id = uuid4().hex
    key = keys.raw_photo_key(lot.lot_id, body.view_id, image_id, _EXTENSIONS[body.content_type])
    _claim(repo, body.sha256, image_id, now)
    try:
        repo.put_snapshot(
            Snapshot(
                image_id=image_id,
                lot_id=lot.lot_id,
                view_id=body.view_id,
                capture_time=capture_time,
                sha256=body.sha256,
                s3_key=key,
                content_type=body.content_type,
                size_bytes=body.size_bytes,
                uploaded_by=admin.email,
                created_at=now,
            )
        )
        ttl = settings.upload_url_ttl_seconds
        url = adapters.object_store.presign_put(key, body.content_type, expires_seconds=ttl)
    except Exception:
        # Free the hash so the same photo can be uploaded again. If this fails too, the
        # orphaned claim is taken over once ORPHAN_CLAIM_GRACE has passed.
        try:
            repo.release_hash(body.sha256, image_id)
        except Exception:
            log.exception("could not release hash claim", extra={"image_id": image_id})
        raise
    return UploadSlot(image_id=image_id, upload_url=url, expires_at=now + timedelta(seconds=ttl))


@router.post(
    "/{image_id}/complete",
    response_model=UploadCompleteResponse,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        409: {
            "model": ErrorResponse,
            "description": (
                "not_pending | missing_object: the file was never uploaded | "
                "size_mismatch: the stored file size differs from sizeBytes | "
                "unsupported_type: the stored file is not JPEG or PNG"
            ),
        },
        410: {"model": ErrorResponse, "description": "expired"},
    },
    summary="Confirm the file arrived and queue the job",
)
def complete_upload(
    image_id: str, admin: AdminDep, adapters: AdaptersDep, settings: SettingsDep, now: NowDep
) -> UploadCompleteResponse:
    repo = adapters.repository
    snap = repo.get_snapshot(image_id)
    if snap is None:
        raise error(404, "not_found", "Upload not found")
    status = effective_status(snap, now)
    if status == EXPIRED:
        raise error(410, "expired", "This upload expired. Please upload the photo again")
    if snap.job_status is not JobStatus.UPLOAD_PENDING:
        raise error(409, "not_pending", "This upload was already completed")
    info = adapters.object_store.head(snap.s3_key)
    if info is None:
        raise error(409, "missing_object", "The photo has not finished uploading")
    if info.size_bytes != snap.size_bytes:
        raise error(409, "size_mismatch", "The uploaded file is not the size that was declared")
    media_type = info.content_type.split(";", 1)[0].strip().lower()
    if media_type not in settings.allowed_upload_types:
        raise error(409, "unsupported_type", "Photos must be JPEG or PNG")
    lot = repo.get_lot(snap.lot_id)
    moved = repo.transition_job(
        image_id,
        {JobStatus.UPLOAD_PENDING},
        JobStatus.QUEUED,
        queued_at=now,
        layout_version=lot.current_layout_version if lot else None,
    )
    if not moved:
        raise error(409, "not_pending", "This upload was already completed")
    enqueue_job(adapters, image_id)
    return UploadCompleteResponse(image_id=image_id, job_status=JobStatus.QUEUED.value)
