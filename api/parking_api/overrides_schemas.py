"""Request/response schemas for admin state overrides."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from parking_core.models import CamelModel
from pydantic import AwareDatetime, Field, field_validator

OverrideState = Literal["FREE", "OCCUPIED"]


class OverrideCreate(CamelModel):
    space_ids: list[str] = Field(
        min_length=1, max_length=500, description="Spaces to set; duplicates dropped"
    )
    state: OverrideState
    note: str = Field(default="", max_length=200, description="Shown to drivers")
    starts_at: AwareDatetime | None = Field(
        default=None,
        description="Omit to start now (the server's clock, so an admin's clock never delays "
        "it); a later time schedules it",
    )
    ends_at: AwareDatetime | None = Field(
        default=None, description="Null until an admin ends it; must be after startsAt"
    )

    @field_validator("space_ids")
    @classmethod
    def _dedupe(cls, ids: list[str]) -> list[str]:
        return list(dict.fromkeys(ids))


class OverrideOut(CamelModel):
    override_id: str
    lot_id: str
    space_ids: list[str]
    state: OverrideState
    note: str
    starts_at: datetime
    ends_at: datetime | None
    created_by: str
    created_at: datetime
    ended_at: datetime | None = Field(description="Set when an admin ended it early")
    active: bool = Field(description="In effect right now")
    status: Literal["SCHEDULED", "ACTIVE", "ENDED"]
