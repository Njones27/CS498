"""Domain models (HDD §5.1). Python uses snake_case; JSON/DynamoDB use camelCase."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Point = tuple[float, float]
"""(x, y) as fractions of the image size, 0..1 (what ACPDS expects)."""
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
    """Schematic rectangle in schematic units (see `Schematic`)."""

    x: float
    y: float
    w: float
    h: float


class Schematic(CamelModel):
    width: float = 1000
    height: float = 600


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


class CarBox(CamelModel):
    """One object detection on a photo (any class, e.g. car or a misread "cell phone"), kept
    for the admin photo overlay. Only car/truck/bus count towards car overlap."""

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
    created_at: datetime
    queued_at: datetime | None = None
    completed_at: datetime | None = None
    detections: list[CarBox] = Field(default_factory=list)
    """Every detection on the photo at the detector's confidence floor, any class (set on
    COMPLETE), including ones touching no space."""


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
    car_boxes: list[CarBox] = Field(default_factory=list)
    """Car/truck/bus detections that touch this space (overlap > 0)."""


class SpaceStatus(CamelModel):
    """Current view for the dashboard. `confidence` is the ACPDS occupied score of the
    observation behind this state; the API exposes it as `spaces[].score`."""

    lot_id: str
    space_id: str
    state: SpaceState
    confidence: float | None = None
    observed_at: datetime
    source_image_id: str


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
    car_boxes: list[CarBox] = Field(default_factory=list)
    """Car/truck/bus detections whose car region overlaps this space (overlap > 0)."""


class Message(CamelModel):
    """A received queue message. `receive_count` mirrors SQS ApproximateReceiveCount."""

    body: str
    receipt: str
    receive_count: int = 1


class JobMessage(CamelModel):
    image_id: str


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
