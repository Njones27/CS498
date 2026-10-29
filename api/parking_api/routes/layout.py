"""Admin draft layout: load and save the editable copy of a lot's layout (brief §4.1).

Saves are not one transaction: spaces and viewpoints are written first and the draft meta
last, as a conditional write on `revision`, so a failed save never advances the revision.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from parking_core.interfaces import ObjectStore
from parking_core.layouts import ensure_draft_meta, published_space_ids
from parking_core.models import (
    DraftMeta,
    Lot,
    OutlineReview,
    ParkingSpace,
    Rect,
    Schematic,
    Viewpoint,
)

from ..deps import AdaptersDep, AdminDep, NowDep, error
from ..layout_schemas import (
    DraftErrorResponse,
    DraftLayout,
    DraftLayoutUpdate,
    DraftRect,
    DraftSchematic,
    DraftSpace,
    DraftViewpoint,
    OutlineReviewOut,
    ReferenceImageOut,
)
from ..schemas import ErrorResponse

router = APIRouter(prefix="/admin/lots/{lot_id}/layout", tags=["admin"])

_AUTH = {401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}}

STALE_MESSAGE = "This draft changed in another window. Reload to see the latest."


def _space_out(s: ParkingSpace) -> DraftSpace:
    return DraftSpace(
        space_id=s.space_id,
        label=s.label,
        type=s.space_type,
        rect=DraftRect(x=s.rect.x, y=s.rect.y, w=s.rect.w, h=s.rect.h),
        retired=s.retired,
    )


def _viewpoint_out(v: Viewpoint, store: ObjectStore) -> DraftViewpoint:
    reference = None
    if v.reference_image_key is not None:
        reference = ReferenceImageOut(
            url=store.presign_get(v.reference_image_key),
            width=v.image_width,
            height=v.image_height,
        )
    return DraftViewpoint(
        view_id=v.view_id,
        name=v.name,
        reference_image=reference,
        outlines={sid: list(poly) for sid, poly in v.outlines.items()},
        outline_review={
            sid: OutlineReviewOut(source=r.source, status=r.status)
            for sid, r in v.outline_review.items()
        },
    )


def draft_out(
    meta: DraftMeta, spaces: list[ParkingSpace], views: list[Viewpoint], store: ObjectStore
) -> DraftLayout:
    """Spaces and viewpoints sorted by id, so every adapter returns the same order."""
    return DraftLayout(
        lot_id=meta.lot_id,
        revision=meta.revision,
        based_on_version=meta.based_on_version,
        updated_at=meta.updated_at,
        updated_by=meta.updated_by,
        schematic=DraftSchematic(width=meta.schematic.width, height=meta.schematic.height),
        spaces=[_space_out(s) for s in sorted(spaces, key=lambda s: s.space_id)],
        viewpoints=[_viewpoint_out(v, store) for v in sorted(views, key=lambda v: v.view_id)],
    )


def _require_lot(adapters: AdaptersDep, lot_id: str) -> Lot:
    lot = adapters.repository.get_lot(lot_id)
    if lot is None:
        raise error(404, "not_found", "Lot not found")
    return lot


@router.get(
    "/draft",
    response_model=DraftLayout,
    responses={**_AUTH, 404: {"model": ErrorResponse}},
    summary="The lot's editable draft layout",
)
def get_draft(lot_id: str, admin: AdminDep, adapters: AdaptersDep, now: NowDep) -> DraftLayout:
    repo = adapters.repository
    meta = ensure_draft_meta(repo, _require_lot(adapters, lot_id), now)
    return draft_out(
        meta, repo.list_spaces(lot_id), repo.list_viewpoints(lot_id), adapters.object_store
    )


@router.put(
    "/draft",
    response_model=DraftLayout,
    responses={
        **_AUTH,
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse, "description": "stale_revision"},
        422: {
            "model": DraftErrorResponse,
            "description": "cannot_delete_published_space or validation_error",
        },
    },
    summary="Save the draft layout; drivers see nothing until it is published",
)
def put_draft(
    lot_id: str, body: DraftLayoutUpdate, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> DraftLayout:
    repo, store = adapters.repository, adapters.object_store
    meta = ensure_draft_meta(repo, _require_lot(adapters, lot_id), now)
    if body.revision != meta.revision:
        raise error(409, "stale_revision", STALE_MESSAGE)

    stored_spaces = {s.space_id for s in repo.list_spaces(lot_id)}
    removed = stored_spaces - {s.space_id for s in body.spaces}
    locked = sorted(removed & published_space_ids(repo, store, lot_id)) if removed else []
    if locked:
        raise error(
            422,
            "cannot_delete_published_space",
            f"Published spaces can't be deleted. Retire them instead: {', '.join(locked)}",
            spaceIds=locked,
        )
    stored_views = {v.view_id: v for v in repo.list_viewpoints(lot_id)}
    missing_views = sorted(set(stored_views) - {v.view_id for v in body.viewpoints})
    if missing_views:
        raise error(
            422, "validation_error", f"Viewpoints can't be removed: {', '.join(missing_views)}"
        )

    repo.put_spaces(
        ParkingSpace(
            lot_id=lot_id,
            space_id=s.space_id,
            label=s.label,
            space_type=s.type,
            rect=Rect(x=s.rect.x, y=s.rect.y, w=s.rect.w, h=s.rect.h),
            retired=s.retired,
        )
        for s in body.spaces
    )
    for v in body.viewpoints:
        existing = stored_views.get(v.view_id)
        # Keep everything the body does not carry: the reference image fields (set only by
        # the reference photo endpoints) and the camera fields.
        base = (
            existing.model_dump(by_alias=False)
            if existing
            else {"lot_id": lot_id, "view_id": v.view_id}
        )
        edits = {
            "name": v.name,
            "outlines": v.outlines,
            "outline_review": {
                sid: OutlineReview(source=r.source, status=r.status)
                for sid, r in v.outline_review.items()
            },
        }
        repo.put_viewpoint(Viewpoint.model_validate({**base, **edits}))
    for space_id in removed:
        repo.delete_space(lot_id, space_id)

    saved = _saved_meta(meta, body.schematic, admin.email, now)
    if not repo.put_draft_meta(saved, expected_revision=meta.revision):
        raise error(409, "stale_revision", STALE_MESSAGE)
    return draft_out(saved, repo.list_spaces(lot_id), repo.list_viewpoints(lot_id), store)


def _saved_meta(meta: DraftMeta, schematic: DraftSchematic, email: str, now: datetime) -> DraftMeta:
    return meta.model_copy(
        update={
            "revision": meta.revision + 1,
            "schematic": Schematic(width=schematic.width, height=schematic.height),
            "updated_at": now,
            "updated_by": email,
        }
    )
