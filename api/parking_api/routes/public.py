"""Public driver routes (HDD §6.1)."""

from __future__ import annotations

import logging

from fastapi import APIRouter
from parking_core.errors import NotPublishedError
from parking_core.interfaces import Repository
from parking_core.models import Lot, PublishedLayout
from parking_core.status import build_status, lot_summary
from pydantic import ValidationError

from ..deps import AdaptersDep, NowDep, error
from ..schemas import (
    ErrorResponse,
    HealthResponse,
    LayoutOut,
    LotDetail,
    LotInfo,
    LotListItem,
    LotStatusOut,
    LotSummary,
    RectOut,
    SchematicOut,
    SchematicSpace,
    ViewpointOut,
)

router = APIRouter(tags=["public"])
log = logging.getLogger(__name__)

# How many of the newest captures the processing note looks through for a photo in flight.
# A heuristic window: a job never stays in flight for good, since the worker marks it FAILED
# after MAX_ATTEMPTS receives. One small GSI query per status poll.
RECENT_SNAPSHOTS = 20


def find_published(repo: Repository, lot_id: str) -> tuple[Lot, PublishedLayout] | None:
    """The lot and its current layout, or None when unknown or unpublished.

    A snapshot that is missing or no longer loads also counts as unpublished, so one bad lot
    can't fail `GET /lots` for every driver. The unreadable case is logged as an error."""
    lot = repo.get_lot(lot_id)
    if lot is None or lot.current_layout_version is None:
        return None
    try:
        layout = repo.get_published_layout(lot_id)
    except NotPublishedError:
        return None
    except ValidationError:
        log.exception(
            "Published layout of lot %s v%s does not load", lot_id, lot.current_layout_version
        )
        return None
    return (lot, layout) if layout is not None else None


def require_published(repo: Repository, lot_id: str) -> tuple[Lot, PublishedLayout]:
    found = find_published(repo, lot_id)
    if found is None:
        raise error(404, "not_found", "Lot not found")
    return found


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@router.get("/lots", response_model=list[LotListItem], summary="List published lots")
def list_lots(adapters: AdaptersDep, now: NowDep) -> list[LotListItem]:
    repo = adapters.repository
    items = []
    for candidate in sorted(repo.list_lots(), key=lambda lot: lot.name.lower()):
        if candidate.current_layout_version is None:
            continue
        found = find_published(repo, candidate.lot_id)
        if found is None:
            continue
        lot, layout = found
        summary = lot_summary(
            lot,
            layout,
            repo.get_statuses(lot.lot_id),
            repo.list_closures(lot.lot_id),
            now,
            repo.list_overrides(lot.lot_id),
        )
        items.append(
            LotListItem(
                lot_id=lot.lot_id,
                name=lot.name,
                location=lot.location,
                stale_after_minutes=lot.stale_after_minutes,
                layout_version=layout.version,
                summary=LotSummary.model_validate(summary),
            )
        )
    return items


@router.get(
    "/lots/{lot_id}",
    response_model=LotDetail,
    responses={404: {"model": ErrorResponse}},
    summary="Lot details, published schematic layout and viewpoints",
)
def get_lot(lot_id: str, adapters: AdaptersDep) -> LotDetail:
    lot, layout = require_published(adapters.repository, lot_id)
    return LotDetail(
        lot=LotInfo(
            lot_id=lot.lot_id,
            name=lot.name,
            location=lot.location,
            stale_after_minutes=lot.stale_after_minutes,
        ),
        layout=LayoutOut(
            version=layout.version,
            schematic=SchematicOut(width=layout.schematic.width, height=layout.schematic.height),
            spaces=[
                SchematicSpace(
                    space_id=s.space_id,
                    label=s.label,
                    type=s.space_type,
                    rect=RectOut(x=s.rect.x, y=s.rect.y, w=s.rect.w, h=s.rect.h),
                )
                for s in layout.active_spaces()
            ],
        ),
        viewpoints=[ViewpointOut(view_id=v.view_id, name=v.name) for v in layout.viewpoints],
    )


@router.get(
    "/lots/{lot_id}/status",
    response_model=LotStatusOut,
    responses={404: {"model": ErrorResponse}},
    summary="Current state of every space (HDD §6.2)",
)
def get_status(lot_id: str, adapters: AdaptersDep, now: NowDep) -> LotStatusOut:
    repo = adapters.repository
    lot, layout = require_published(repo, lot_id)
    out = build_status(
        lot,
        layout,
        repo.get_statuses(lot_id),
        repo.list_closures(lot_id),
        repo.list_snapshots(lot_id, limit=RECENT_SNAPSHOTS),
        now,
        repo.list_overrides(lot_id),
    )
    return LotStatusOut.model_validate(out)
