"""Test-only upload target and photo reads. Mounted only when APP_ENV=test (the memory object
store has no S3, so presigned PUT/GET URLs point here)."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

from ..deps import AdaptersDep, error
from ..schemas import ErrorResponse

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


@router.get(
    "/objects/{key:path}",
    response_class=Response,
    responses={
        200: {"description": "The stored bytes with their content type"},
        404: {"model": ErrorResponse},
    },
    summary="Serve a stored object the way a presigned GET would",
)
def test_object(key: str, adapters: AdaptersDep) -> Response:
    store = adapters.object_store
    info = store.head(key)
    if info is None:
        raise error(404, "not_found", "Object not found")
    return Response(content=store.get(key), media_type=info.content_type)
