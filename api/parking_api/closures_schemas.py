"""Request/response schemas for admin closures (US-10)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from parking_core.models import CamelModel, ClosureReason
from pydantic import AwareDatetime, Field, field_validator


class ClosureCreate(CamelModel):
    space_ids: list[str] = Field(min_length=1, description="Spaces to close; duplicates dropped")
    reason: ClosureReason
    starts_at: AwareDatetime
    ends_at: AwareDatetime | None = Field(
        default=None, description="Null for an open-ended closure; must be after startsAt"
    )

    @field_validator("space_ids")
    @classmethod
    def _dedupe(cls, ids: list[str]) -> list[str]:
        return list(dict.fromkeys(ids))


class ClosureOut(CamelModel):
    closure_id: str
    lot_id: str
    space_ids: list[str]
    reason: ClosureReason
    starts_at: datetime
    ends_at: datetime | None
    created_by: str
    created_at: datetime
    ended_at: datetime | None = Field(description="Set when an admin ended the closure early")
    active: bool = Field(description="In effect right now")
    status: Literal["SCHEDULED", "ACTIVE", "ENDED"] = Field(
        description="ENDED if ended early or past endsAt; ACTIVE once startsAt has passed"
    )
