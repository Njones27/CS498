"""Admin reference photo endpoints (US-08)."""

from __future__ import annotations

import hashlib
from datetime import timedelta

from fastapi import APIRouter
from parking_core import keys

from ..deps import AdaptersDep, AdminDep, NowDep, SettingsDep, error
from ..image_size import image_size
from ..reference_schemas import (
    ReferenceCompleteRequest,
    ReferenceCompleteResponse,
    ReferenceImageInfo,
    ReferenceUploadRequest,
    ReferenceUploadSlot,
)
from ..schemas import ErrorResponse
from ..upload_validation import validate_photo_type_and_size

router = APIRouter(prefix="/admin/lots/{lot_id}/views/{view_id}/reference", tags=["admin"])

_AUTH = {401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}}


@router.post(
    "",
    response_model=ReferenceUploadSlot,
    status_code=201,
    responses={
        **_AUTH,
        404: {"model": ErrorResponse},
        422: {
            "model": ErrorResponse,
            "description": "too_large | unsupported_type | validation_error",
        },
    },
    summary="Reserve a reference photo upload slot; returns presigned PUT URL",
)
def request_reference_upload(
    lot_id: str,
    view_id: str,
    body: ReferenceUploadRequest,
    admin: AdminDep,
    adapters: AdaptersDep,
    settings: SettingsDep,
    now: NowDep,
) -> ReferenceUploadSlot:
    repo = adapters.repository
    if repo.get_lot(lot_id) is None:
        raise error(404, "not_found", "Lot not found")
    vp = repo.get_viewpoint(lot_id, view_id)
    if vp is None:
        raise error(404, "not_found", "Viewpoint not found")

    validate_photo_type_and_size(body.content_type, body.size_bytes, settings)

    key = keys.reference_image_key(lot_id, view_id, body.sha256)
    ttl = settings.upload_url_ttl_seconds
    upload_url = adapters.object_store.presign_put(key, body.content_type, expires_seconds=ttl)
    return ReferenceUploadSlot(upload_url=upload_url, expires_at=now + timedelta(seconds=ttl))


@router.post(
    "/complete",
    response_model=ReferenceCompleteResponse,
    status_code=200,
    responses={
        **_AUTH,
        404: {"model": ErrorResponse},
        409: {
            "model": ErrorResponse,
            "description": (
                "missing_object: file was never uploaded | hash_mismatch | "
                "too_large: the stored file is over the size limit | "
                "unsupported_type: the stored file is not a readable JPEG or PNG"
            ),
        },
    },
    summary="Confirm the reference photo arrived and record its size, read from the file",
)
def complete_reference_upload(
    lot_id: str,
    view_id: str,
    body: ReferenceCompleteRequest,
    admin: AdminDep,
    adapters: AdaptersDep,
    settings: SettingsDep,
    now: NowDep,
) -> ReferenceCompleteResponse:
    repo = adapters.repository
    if repo.get_lot(lot_id) is None:
        raise error(404, "not_found", "Lot not found")
    vp = repo.get_viewpoint(lot_id, view_id)
    if vp is None:
        raise error(404, "not_found", "Viewpoint not found")

    key = keys.reference_image_key(lot_id, view_id, body.sha256)
    store = adapters.object_store
    info = store.head(key)
    if info is None:
        raise error(409, "missing_object", "The photo has not finished uploading")
    # A presigned PUT cannot cap the body, so the reserved size proves nothing: check the stored
    # object before reading it. The whole object is then at most max_upload_bytes.
    if info.size_bytes > settings.max_upload_bytes:
        raise error(409, "too_large", "Photos must be 15 MB or smaller")
    media_type = info.content_type.split(";", 1)[0].strip().lower()
    if media_type not in settings.allowed_upload_types:
        raise error(409, "unsupported_type", "Photos must be JPEG or PNG")

    data = store.get(key)
    actual_hash = hashlib.sha256(data).hexdigest()
    if actual_hash != body.sha256:
        raise error(409, "hash_mismatch", "Uploaded file does not match its hash")
    # The outlines and the worker's aligner depend on these, so they come from the file.
    size = image_size(data, media_type)
    if size is None:
        raise error(409, "unsupported_type", "Photos must be JPEG or PNG")
    width, height = size

    # Only the photo fields: a draft save running now writes the outlines, and neither write may
    # put back the other's old value.
    if not repo.update_viewpoint(
        lot_id, view_id, reference_image_key=key, image_width=width, image_height=height
    ):
        raise error(404, "not_found", "Viewpoint not found")

    url = store.presign_get(key)
    return ReferenceCompleteResponse(
        view_id=view_id,
        reference_image=ReferenceImageInfo(url=url, width=width, height=height),
    )
