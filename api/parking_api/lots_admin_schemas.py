"""Request/response schemas for admin lot management (US-16)."""

from __future__ import annotations

from datetime import datetime

from parking_core.models import CamelModel
from pydantic import Field, field_validator


class AdminLotCreate(CamelModel):
    name: str = Field(description="Trimmed; must not be blank or match another lot's name")
    location: str = Field(default="", description="Free text, trimmed")
    stale_after_minutes: int = Field(
        default=30, ge=1, le=1440, description="Allowed data age before drivers see a stale banner"
    )

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, name: str) -> str:
        name = name.strip()
        if not name:
            raise ValueError("Name is required")
        return name

    @field_validator("location")
    @classmethod
    def _trim_location(cls, location: str) -> str:
        return location.strip()


class AdminLotOut(CamelModel):
    lot_id: str
    name: str
    location: str
    stale_after_minutes: int
    published: bool = Field(description="Has a published layout, so drivers can see it")
    layout_version: int | None = Field(description="Current published version; null if never")
    created_at: datetime
