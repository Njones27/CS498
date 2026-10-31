"""Schemas for the layout proposer endpoints (HDD §4.6)."""

from __future__ import annotations

from datetime import datetime

from parking_core.models import CamelModel, ProposalStatus, ProposedStall
from pydantic import Field


class ProposalRunOut(CamelModel):
    """The latest layout proposer run on a viewpoint's reference photo."""

    run_id: str
    lot_id: str
    view_id: str
    status: ProposalStatus
    requested_by: str
    requested_at: datetime
    completed_at: datetime | None = None
    error: str | None = None
    model_version: str | None = None
    photo_changed: bool = Field(
        description="The viewpoint's reference photo changed since this run was requested"
    )
    stalls: list[ProposedStall] = Field(
        default_factory=list, description="Proposed stall outlines, once COMPLETE"
    )
