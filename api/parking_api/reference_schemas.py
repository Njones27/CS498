"""Schemas for viewpoint reference photo upload and completion."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from parking_core.models import CamelModel
from pydantic import Field


class ReferenceUploadRequest(CamelModel):
    content_type: Literal["image/jpeg", "image/png"]
    size_bytes: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ReferenceUploadSlot(CamelModel):
    upload_url: str
    expires_at: datetime


class ReferenceCompleteRequest(CamelModel):
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class ReferenceImageInfo(CamelModel):
    url: str
    width: int
    height: int


class ReferenceCompleteResponse(CamelModel):
    view_id: str
    reference_image: ReferenceImageInfo
