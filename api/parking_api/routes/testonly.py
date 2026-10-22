"""Test-only upload target. Mounted only when APP_ENV=test (memory object store has no S3)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..deps import AdaptersDep, error

router = APIRouter(prefix="/_test", tags=["test-only"])


@router.put(
    "/uploads/{image_id}", status_code=204, summary="Accept the bytes a presigned PUT would"
)
async def test_upload(image_id: str, request: Request, adapters: AdaptersDep) -> None:
    body = await request.body()
    content_type = request.headers.get("content-type", "application/octet-stream")
    store = adapters.object_store
    if not store.put_for_image(image_id, body, content_type):  # type: ignore[attr-defined]
        raise error(404, "not_found", "No upload slot for this image")
