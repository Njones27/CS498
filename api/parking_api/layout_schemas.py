"""Request/response schemas for the draft layout API (brief §4.1; US-07 #7, US-09).

Models used in both the request and the response (`DraftSpace`, `OutlineReviewOut`, ...)
have no defaults, so OpenAPI emits one schema each instead of -Input/-Output pairs.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated

from parking_core.layouts import ValidationReport
from parking_core.models import CamelModel, OutlineSource, OutlineStatus, SpaceType
from pydantic import Field, FiniteFloat, model_validator

from .schemas import ErrorResponse

Corner = tuple[FiniteFloat, FiniteFloat]  # NaN/inf would be stored as null (models.Point)
Outline = Annotated[
    list[Corner],
    Field(
        min_length=4,
        max_length=4,
        description="Four corners as fractions of the photo (0..1), clockwise",
    ),
]
MAX_REJECTED_STALLS = 1000
"""Per viewpoint; the editor keeps the latest this many (web/src/mapping/proposals.ts)."""

ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
"""Space and viewpoint ids. They become parts of DynamoDB keys, where `#` separates fields, and
viewpoint ids become parts of S3 keys, so only letters, digits, `-` and `_` are allowed."""
_ID_RE = re.compile(ID_PATTERN)
MAX_LABEL_LENGTH = 40
"""A space's display label (the editor's Label input has the same maxLength)."""
MAX_NAME_LENGTH = 120
"""A viewpoint's name, as long as a lot's name may be."""


class DraftSchematic(CamelModel):
    width: FiniteFloat = Field(gt=0)
    height: FiniteFloat = Field(gt=0)
    north_deg: FiniteFloat | None = Field(
        default=None,
        ge=0,
        lt=360,
        exclude_if=lambda v: v is None,
        description="Where north is on the map: degrees clockwise from map-up; absent until set",
    )
    rotation_deg: FiniteFloat | None = Field(
        default=None,
        ge=0,
        lt=360,
        exclude_if=lambda v: not v,
        description="Map shown turned this many degrees clockwise; absent when shown as laid out",
    )


class DraftRect(CamelModel):
    """Schematic rectangle in schematic units."""

    # Finite only, like `Corner`: a NaN would be stored as null (models.Rect).
    x: FiniteFloat
    y: FiniteFloat
    w: FiniteFloat
    h: FiniteFloat


class DraftSpace(CamelModel):
    space_id: str = Field(min_length=1, description="Stable id; never changes once created")
    label: str = Field(description="Editable display label")
    type: SpaceType
    rect: DraftRect
    retired: bool
    skew_deg: FiniteFloat | None = Field(
        default=None,
        gt=-80,
        lt=80,
        exclude_if=lambda v: not v,
        description=(
            "Angled parking: how far the stall's sides lean from square to its row, in degrees "
            "(positive leans clockwise); absent for a square stall"
        ),
    )


class OutlineReviewOut(CamelModel):
    source: OutlineSource
    status: OutlineStatus
    evidence: float | None = Field(
        default=None,
        ge=0,
        le=1,
        exclude_if=lambda v: v is None,
        description="For a proposed outline, how strongly the photo supports it (0 to 1)",
    )
    new_space: bool | None = Field(
        default=None,
        exclude_if=lambda v: v is None,
        description="The layout proposer created this space; rejecting the outline removes it",
    )


class ReferenceImageOut(CamelModel):
    url: str = Field(description="Presigned GET, read-only and short-lived")
    width: int | None
    height: int | None


class DraftViewpoint(CamelModel):
    view_id: str
    name: str
    reference_image: ReferenceImageOut | None = Field(
        description="Null until a reference photo is uploaded"
    )
    outlines: dict[str, Outline] = Field(description="spaceId -> outline on the reference photo")
    outline_review: dict[str, OutlineReviewOut]
    rejected_stalls: list[Outline] = Field(
        default_factory=list,
        description="Stalls an admin rejected when Find stalls proposed them; it skips them",
    )


class DraftLayout(CamelModel):
    lot_id: str
    revision: int = Field(description="Bumps on every successful save")
    based_on_version: int | None = Field(
        description="Published version this draft started from; null if never published"
    )
    updated_at: datetime
    updated_by: str | None = Field(description="Null until the first save")
    schematic: DraftSchematic
    spaces: list[DraftSpace]
    viewpoints: list[DraftViewpoint]


class DraftViewpointIn(CamelModel):
    """A viewpoint in a draft save. The reference photo is set only by its own endpoints."""

    view_id: str = Field(
        pattern=ID_PATTERN, description="Letters, digits, '-' and '_' only, at most 64"
    )
    name: str = Field(max_length=MAX_NAME_LENGTH)
    outlines: dict[str, Outline] = Field(default_factory=dict)
    outline_review: dict[str, OutlineReviewOut] = Field(default_factory=dict)
    rejected_stalls: list[Outline] = Field(default_factory=list, max_length=MAX_REJECTED_STALLS)


class DraftLayoutUpdate(CamelModel):
    """PUT body: the DraftLayout shape without updatedAt, updatedBy and referenceImage.

    Each space's spaceId must be 1 to 64 letters, digits, '-' or '_', and its label at most 40
    characters. Those are checked here, not on DraftSpace, because DraftSpace is also the
    response shape and a draft stored before the rules must still load."""

    revision: int = Field(description="Must equal the stored revision, else 409 stale_revision")
    schematic: DraftSchematic
    spaces: list[DraftSpace]
    viewpoints: list[DraftViewpointIn]

    @model_validator(mode="after")
    def _space_fields(self) -> DraftLayoutUpdate:
        for s in self.spaces:
            if not _ID_RE.match(s.space_id):
                raise ValueError(
                    f"spaceId must be 1 to 64 letters, digits, '-' or '_': {s.space_id[:64]!r}"
                )
            if len(s.label) > MAX_LABEL_LENGTH:
                raise ValueError(
                    f"Label of {s.space_id} is longer than {MAX_LABEL_LENGTH} characters"
                )
        return self

    @model_validator(mode="after")
    def _unique_ids(self) -> DraftLayoutUpdate:
        for kind, ids in (
            ("spaceId", [s.space_id for s in self.spaces]),
            ("viewId", [v.view_id for v in self.viewpoints]),
        ):
            seen: set[str] = set()
            for i in ids:
                if i in seen:
                    raise ValueError(f"Duplicate {kind}: {i}")
                seen.add(i)
        return self


class DraftErrorResponse(ErrorResponse):
    space_ids: list[str] | None = Field(
        default=None, description="Set on 422 cannot_delete_published_space"
    )


class PublishRequest(CamelModel):
    revision: int = Field(description="The draft revision being published, else 409 stale_revision")


class LayoutVersionOut(CamelModel):
    version: int
    published_by: str
    published_at: datetime
    rescoring: list[str] = Field(
        default_factory=list,
        exclude_if=lambda v: not v,
        description=(
            "Publish only: image ids of the latest photos being scored again against this "
            "version (one per viewpoint); absent when there is none"
        ),
    )


class ValidationFailedResponse(ErrorResponse):
    report: ValidationReport = Field(description="Set on 409 validation_failed")
