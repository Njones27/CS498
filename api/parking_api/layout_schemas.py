"""Request/response schemas for the draft layout API (brief §4.1; US-07 #7, US-09).

Models used in both the request and the response (`DraftSpace`, `OutlineReviewOut`, ...)
have no defaults, so OpenAPI emits one schema each instead of -Input/-Output pairs.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from parking_core.models import CamelModel, OutlineSource, OutlineStatus, SpaceType
from pydantic import Field, model_validator

from .schemas import ErrorResponse

Corner = tuple[float, float]
Outline = Annotated[
    list[Corner],
    Field(
        min_length=4,
        max_length=4,
        description="Four corners as fractions of the photo (0..1), clockwise",
    ),
]


class DraftSchematic(CamelModel):
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class DraftRect(CamelModel):
    """Schematic rectangle in schematic units."""

    x: float
    y: float
    w: float
    h: float


class DraftSpace(CamelModel):
    space_id: str = Field(min_length=1, description="Stable id; never changes once created")
    label: str = Field(description="Editable display label")
    type: SpaceType
    rect: DraftRect
    retired: bool


class OutlineReviewOut(CamelModel):
    source: OutlineSource
    status: OutlineStatus


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

    view_id: str = Field(min_length=1)
    name: str
    outlines: dict[str, Outline] = Field(default_factory=dict)
    outline_review: dict[str, OutlineReviewOut] = Field(default_factory=dict)


class DraftLayoutUpdate(CamelModel):
    """PUT body: the DraftLayout shape without updatedAt, updatedBy and referenceImage."""

    revision: int = Field(description="Must equal the stored revision, else 409 stale_revision")
    schematic: DraftSchematic
    spaces: list[DraftSpace]
    viewpoints: list[DraftViewpointIn]

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
