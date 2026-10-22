"""Request/response schemas. This file plus the routes define contract/openapi.json."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from parking_core.models import CamelModel, ClosureReason, SpaceState, SpaceType
from pydantic import Field

JobStatusOut = Literal["UPLOAD_PENDING", "QUEUED", "PROCESSING", "COMPLETE", "FAILED", "EXPIRED"]
"""JobStatus values plus the derived EXPIRED (UPLOAD_PENDING older than 15 minutes)."""


class ErrorResponse(CamelModel):
    error: str = Field(description="Machine-readable code, e.g. duplicate, session_expired")
    message: str
    original_image_id: str | None = Field(default=None, description="Set on 409 duplicate")
    uploaded_at: datetime | None = Field(default=None, description="Set on 409 duplicate")
    details: list[dict[str, object]] | None = Field(
        default=None, description="Pydantic error list on 422 validation_error"
    )


class HealthResponse(CamelModel):
    status: Literal["ok"] = "ok"


# --- auth -------------------------------------------------------------------


class LoginRequest(CamelModel):
    email: str
    password: str


class LoginResponse(CamelModel):
    token: str
    expires_at: datetime
    email: str
    groups: list[str]


# --- public lots ------------------------------------------------------------


class LotSummary(CamelModel):
    free: int
    occupied: int
    unknown: int
    closed: int
    total: int = Field(
        description="Active spaces minus closed ones; the denominator of openPercent"
    )
    open_percent: int | None = Field(
        description="round(free / total * 100), or null when hasRecentData is false or total is 0"
    )
    is_stale: bool = Field(description="Some nonclosed space is past the lot's allowed data age")
    has_recent_data: bool = Field(
        description="At least one nonclosed space has a fresh observation"
    )


class LotListItem(CamelModel):
    """Only lots with a published layout appear; layoutVersion is therefore never null."""

    lot_id: str
    name: str
    location: str
    stale_after_minutes: int
    layout_version: int
    summary: LotSummary


class LotInfo(CamelModel):
    lot_id: str
    name: str
    location: str
    stale_after_minutes: int


class RectOut(CamelModel):
    x: float
    y: float
    w: float
    h: float


class SchematicSpace(CamelModel):
    space_id: str
    label: str
    type: SpaceType = Field(description="ParkingSpace.spaceType in the published layout JSON")
    rect: RectOut


class SchematicOut(CamelModel):
    width: float
    height: float


class LayoutOut(CamelModel):
    version: int
    schematic: SchematicOut
    spaces: list[SchematicSpace]


class ViewpointOut(CamelModel):
    view_id: str
    name: str


class LotDetail(CamelModel):
    lot: LotInfo
    layout: LayoutOut
    viewpoints: list[ViewpointOut]


class ClosureInfo(CamelModel):
    reason: ClosureReason
    ends_at: datetime | None


class SpaceStatusOut(CamelModel):
    space_id: str
    state: SpaceState
    observed_at: datetime | None = Field(description="Capture time of the photo behind this state")
    score: float | None = Field(description="ACPDS occupied score, for tooltips and admin views")
    stale: bool
    closure: ClosureInfo | None


class StatusCounts(CamelModel):
    free: int
    occupied: int
    unknown: int
    closed: int


class LotStatusOut(CamelModel):
    lot_id: str
    last_observed_at: datetime | None
    is_stale: bool
    processing: bool = Field(
        description="A snapshot for this lot is QUEUED or PROCESSING (US-11 #5)"
    )
    no_observations: bool = Field(
        description="No space has any observation yet; show 'No observations yet' (US-01 #5)"
    )
    layout_version: int
    spaces: list[SpaceStatusOut]
    counts: StatusCounts


# --- admin uploads ----------------------------------------------------------


class UploadRequest(CamelModel):
    """Accepted types and the 15 MB cap are fixed in the contract (HDD §10); the matching
    settings exist for the presign policy and must agree with these."""

    lot_id: str
    view_id: str
    capture_time: datetime
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    content_type: Literal["image/jpeg", "image/png"]
    size_bytes: int = Field(gt=0)


class UploadSlot(CamelModel):
    image_id: str
    upload_url: str
    expires_at: datetime


class UploadCompleteResponse(CamelModel):
    image_id: str
    job_status: JobStatusOut


# --- admin snapshots --------------------------------------------------------


class SnapshotOut(CamelModel):
    image_id: str
    lot_id: str
    view_id: str
    capture_time: datetime
    job_status: JobStatusOut
    attempts: int
    finished: bool
    processing_ms: int | None
    model_version: str | None
    error: str | None
    layout_version: int | None
    created_at: datetime


class ObservationOut(CamelModel):
    space_id: str
    state: SpaceState
    acpds_score: float | None
    car_overlap: float | None
    in_frame: bool


class SnapshotDetail(SnapshotOut):
    observations: list[ObservationOut]
