"""Test-only upload target. Mounted only when APP_ENV=test (memory object store has no S3)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..deps import AdaptersDep, error

router = APIRouter(prefix="/_test", tags=["test-only"])

NOT_IMPLEMENTED = error(501, "not_implemented", "Contract stub")


@router.put(
    "/uploads/{image_id}", status_code=204, summary="Accept the bytes a presigned PUT would"
)
async def test_upload(image_id: str, request: Request, adapters: AdaptersDep) -> None:
    raise NOT_IMPLEMENTED
