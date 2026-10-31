"""Domain models (HDD §5.1). Python uses snake_case; JSON/DynamoDB use camelCase."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat
from pydantic.alias_generators import to_camel

Point = tuple[FiniteFloat, FiniteFloat]
"""(x, y) as fractions of the image size, 0..1 (what ACPDS expects). Finite only: a NaN is
stored as JSON null, after which the layout or observation holding it no longer loads."""
Polygon = list[Point]

UPLOAD_EXPIRY = timedelta(minutes=15)
"""An UPLOAD_PENDING snapshot older than this is reported as EXPIRED (HDD §4.2)."""


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="ignore",  # durable JSON (layout snapshots) must survive field removals
    )


class SpaceState(StrEnum):
    FREE = "FREE"
    OCCUPIED = "OCCUPIED"
    UNKNOWN = "UNKNOWN"
    CLOSED = "CLOSED"


class JobStatus(StrEnum):
    UPLOAD_PENDING = "UPLOAD_PENDING"
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    COMPLETE = "COMPLETE"
    FAILED = "FAILED"


EXPIRED = "EXPIRED"
"""Derived status, never stored. See `effective_status`."""


class SpaceType(StrEnum):
    STANDARD = "STANDARD"
    ADA = "ADA"
    EV = "EV"


class ClosureReason(StrEnum):
    CONSTRUCTION = "CONSTRUCTION"
    EVENT = "EVENT"
    MAINTENANCE = "MAINTENANCE"
    RESERVED = "RESERVED"


class Rect(CamelModel):
    """Schematic rectangle in schematic units (see `Schematic`). Finite only, like `Point`."""

    x: FiniteFloat
    y: FiniteFloat
    w: FiniteFloat
    h: FiniteFloat


class Schematic(CamelModel):
    """Finite only, like `Rect`: an infinite width is stored as null in a snapshot."""

    width: FiniteFloat = 1000
    height: FiniteFloat = 600


class Lot(CamelModel):
    lot_id: str
    name: str
    location: str = ""
    stale_after_minutes: int = 30
    current_layout_version: int | None = None
    created_at: datetime


class ParkingSpace(CamelModel):
    lot_id: str
    space_id: str
    label: str
    space_type: SpaceType = SpaceType.STANDARD
    rect: Rect
    retired: bool = False


class OutlineSource(StrEnum):
    DRAWN = "drawn"
    PROPOSED = "proposed"


class OutlineStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"


class OutlineReview(CamelModel):
    """Where one outline came from and whether an admin has reviewed it. Proposed outlines
    (HDD §4.6) start `pending`; validation blocks publishing until they are accepted."""

    source: OutlineSource
    status: OutlineStatus
    evidence: float | None = Field(default=None, ge=0, le=1, exclude_if=lambda v: v is None)
    """For a proposed outline, how strongly the photo supports it (0 to 1): painted lines on
    both sides and a parked car each add to it. The review list shows the weakest first.
    Left out when unset, so drawn outlines store and serialize as before."""
    new_space: bool | None = Field(default=None, exclude_if=lambda v: v is None)
    """True when the layout proposer created the space for this outline (rather than outlining a
    space the lot already had), so rejecting the outline removes the space too. Left out when
    unset."""


class Viewpoint(CamelModel):
    lot_id: str
    view_id: str
    name: str
    reference_image_key: str | None = None
    image_width: int | None = None
    image_height: int | None = None
    outlines: dict[str, Polygon] = Field(default_factory=dict)
    """spaceId -> polygon on this viewpoint's reference image."""
    camera_height_m: float | None = None
    camera_angle_deg: float | None = None
    outline_review: dict[str, OutlineReview] = Field(default_factory=dict)
    """spaceId -> review state of that outline; optional per outline."""


class PublishedLayout(CamelModel):
    """The JSON snapshot stored at layouts/{lotId}/v{version}.json (HDD §5.3)."""

    lot_id: str
    version: int
    schematic: Schematic = Field(default_factory=Schematic)
    spaces: list[ParkingSpace]
    viewpoints: list[Viewpoint]
    published_at: datetime
    published_by: str

    def active_spaces(self) -> list[ParkingSpace]:
        return [s for s in self.spaces if not s.retired]

    def viewpoint(self, view_id: str) -> Viewpoint | None:
        return next((v for v in self.viewpoints if v.view_id == view_id), None)


class LayoutVersion(CamelModel):
    lot_id: str
    version: int
    status: str = "PUBLISHED"
    published_by: str
    published_at: datetime
    snapshot_key: str


class DraftMeta(CamelModel):
    """The draft layout's header item (PK LOT#{lotId}, SK DRAFT). The draft's spaces and
    viewpoints are the lot's SPACE# / VIEW# items; `revision` bumps on every save and guards
    concurrent editors (`Repository.put_draft_meta`)."""

    lot_id: str
    schematic: Schematic = Field(default_factory=Schematic)
    revision: int = 0
    based_on_version: int | None = None
    """Published version this draft started from; None if the lot was never published."""
    updated_at: datetime
    updated_by: str | None = None
    """Admin email of the last save; None until the first save."""


class CarBox(CamelModel):
    """One object detection on a photo (any class, e.g. car or a misread "cell phone"), kept
    for the admin photo overlay (`Repository.put_detections`). Only car/truck/bus count
    towards car overlap."""

    cls_name: str
    conf: float
    box: tuple[float, float, float, float]
    """(x1, y1, x2, y2) as fractions of the photo size, like `Point`."""


class Snapshot(CamelModel):
    """One uploaded photo plus its job record (HDD §1.3, §5.1)."""

    image_id: str
    lot_id: str
    view_id: str
    capture_time: datetime
    sha256: str
    s3_key: str
    content_type: str
    size_bytes: int
    uploaded_by: str
    job_status: JobStatus = JobStatus.UPLOAD_PENDING
    attempts: int = 0
    finished: bool = False
    """True once the job can no longer change on its own (COMPLETE, permanent FAILED,
    or attempts exhausted). Retry is only allowed when finished."""
    error: str | None = None
    model_version: str | None = None
    layout_version: int | None = None
    processing_ms: int | None = None
    rescore_of: str | None = None
    """Set on a re-score: the earlier snapshot whose photo this one scores again against a
    newly published layout version (no new upload; same capture time and object)."""
    created_at: datetime
    queued_at: datetime | None = None
    completed_at: datetime | None = None


def effective_status(snapshot: Snapshot, now: datetime) -> str:
    """Job status as shown to admins: UPLOAD_PENDING older than 15 min reads EXPIRED."""
    if (
        snapshot.job_status is JobStatus.UPLOAD_PENDING
        and now - snapshot.created_at > UPLOAD_EXPIRY
    ):
        return EXPIRED
    return snapshot.job_status.value


class SpaceObservation(CamelModel):
    image_id: str
    lot_id: str
    space_id: str
    state: SpaceState
    acpds_score: float | None = None
    car_overlap: float | None = None
    in_frame: bool = True
    capture_time: datetime
    polygon: Polygon | None = None
    """The space's aligned outline on this photo (fractions); None on older observations."""


class SpaceStatus(CamelModel):
    """One viewpoint's latest reading of a space. The API fuses a space's readings from all
    viewpoints into the state drivers see (`fusion.fuse`). `confidence` is the ACPDS occupied
    score of the observation behind this reading; the API exposes it as `spaces[].score`."""

    lot_id: str
    space_id: str
    state: SpaceState
    confidence: float | None = None
    observed_at: datetime
    source_image_id: str
    view_id: str | None = Field(default=None, exclude_if=lambda v: v is None)
    """The viewpoint this reading comes from; None on readings stored before readings were
    kept per viewpoint."""
    layout_version: int | None = Field(default=None, exclude_if=lambda v: v is None)
    """The layout version the photo was scored with. Breaks a tie in `observed_at`: the same
    photo re-scored after a publish replaces its earlier result (see `supersedes`)."""

    def supersedes(self, current: SpaceStatus | None) -> bool:
        """Newer capture wins (HDD §4.1 step 7); on the same capture time, the newer layout
        version wins, so a re-score after a publish updates the map. Two photos with the same
        time and version keep the first one."""
        if current is None or current.observed_at < self.observed_at:
            return True
        if current.observed_at != self.observed_at or self.layout_version is None:
            return False
        return current.layout_version is None or current.layout_version < self.layout_version


class Closure(CamelModel):
    lot_id: str
    closure_id: str
    space_ids: list[str]
    reason: ClosureReason
    starts_at: datetime
    ends_at: datetime | None = None
    created_by: str
    created_at: datetime
    ended_at: datetime | None = None
    """Set when an admin ends a closure early."""

    def is_active(self, now: datetime) -> bool:
        if self.ended_at is not None and now >= self.ended_at:
            return False
        if now < self.starts_at:
            return False
        return self.ends_at is None or now < self.ends_at


class StateOverride(CamelModel):
    """An admin's word on some spaces' state (FREE or OCCUPIED), shown to drivers over what
    the cameras report until it ends. A closure still wins over it (the space is unusable)."""

    lot_id: str
    override_id: str
    space_ids: list[str]
    state: SpaceState
    note: str = ""
    starts_at: datetime
    ends_at: datetime | None = None
    created_by: str
    created_at: datetime
    ended_at: datetime | None = None
    """Set when an admin ends the override early."""

    def is_active(self, now: datetime) -> bool:
        if self.ended_at is not None and now >= self.ended_at:
            return False
        if now < self.starts_at:
            return False
        return self.ends_at is None or now < self.ends_at


class Principal(CamelModel):
    email: str
    groups: list[str] = Field(default_factory=list)
    expired: bool = False

    @property
    def is_admin(self) -> bool:
        return "admin" in self.groups


class Cutoffs(CamelModel):
    """State rule parameters (HDD §4.5). Tuned in the pilot."""

    low: float = 0.3
    high: float = 0.7
    overlap: float = 0.30
    margin: float = 0.05
    require_car_check: bool = True
    """When True a missing car signal can never yield FREE."""


class AlignedOutline(CamelModel):
    space_id: str
    polygon: Polygon
    in_frame: bool = True


class SpaceScore(CamelModel):
    space_id: str
    acpds_score: float | None = None
    car_overlap: float | None = None
    in_frame: bool = True


class Message(CamelModel):
    """A received queue message. `receive_count` mirrors SQS ApproximateReceiveCount."""

    body: str
    receipt: str
    receive_count: int = 1


class JobMessage(CamelModel):
    image_id: str


class ProposedStall(CamelModel):
    """One stall outline the layout proposer found on a reference photo (HDD §4.6)."""

    polygon: Polygon
    """4 corners as photo fractions, clockwise."""
    evidence: float = Field(ge=0, le=1)
    row: int = Field(ge=0)
    """Row index, rows ordered top to bottom on the photo (in the divider frame)."""
    col: int = Field(ge=0)
    """Stall index within its row, left to right."""
    map_rect: Rect
    """The stall flattened to a top-down map, in photo-width units (0..1 across): position
    along its row and the row's place among the others. The web scales it to the schematic."""


class ProposalStatus(StrEnum):
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    COMPLETE = "COMPLETE"
    FAILED = "FAILED"


class ProposalRun(CamelModel):
    """The latest layout proposer run on one viewpoint's reference photo. One per viewpoint:
    a new run replaces the old one."""

    lot_id: str
    view_id: str
    run_id: str
    status: ProposalStatus = ProposalStatus.QUEUED
    reference_image_key: str
    """The reference photo the run was asked for. A run whose viewpoint photo changed since
    fails rather than propose outlines for a different photo."""
    requested_by: str
    requested_at: datetime
    completed_at: datetime | None = None
    attempts: int = 0
    error: str | None = None
    model_version: str | None = None
    proposals: list[ProposedStall] = Field(default_factory=list)


def check_proposal_run_fields(fields: dict[str, object]) -> None:
    """Fields a proposal run transition may set: any but the run's identity and status."""
    bad = set(fields) - (set(ProposalRun.model_fields) - {"lot_id", "view_id", "run_id", "status"})
    if bad:
        raise ValueError(f"not updatable proposal run fields: {sorted(bad)}")


class ProposalJobMessage(CamelModel):
    """Queue message for a layout proposer run. Told apart from `JobMessage` by `kind`."""

    kind: Literal["propose"] = "propose"
    lot_id: str
    view_id: str
    run_id: str


class ClaimResult(CamelModel):
    claimed: bool
    original_image_id: str | None = None
    claimed_at: datetime | None = Field(
        default=None, description="When the existing claim was made (on conflict)"
    )


class ObjectInfo(CamelModel):
    """Stored object metadata (S3 HeadObject): what actually arrived at a presigned PUT."""

    size_bytes: int
    content_type: str


def utcnow() -> datetime:
    return datetime.now(UTC)
