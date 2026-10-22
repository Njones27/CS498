"""Admin space closures: list, create, end early (US-10)."""

from __future__ import annotations

import secrets
from datetime import datetime

from fastapi import APIRouter
from parking_core.models import Closure

from ..closures_schemas import ClosureCreate, ClosureOut
from ..deps import AdaptersDep, AdminDep, NowDep, error
from ..schemas import ErrorResponse
from .public import find_published

router = APIRouter(prefix="/admin/lots/{lot_id}/closures", tags=["admin"])

_AUTH = {401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}}


def closure_out(c: Closure, now: datetime) -> ClosureOut:
    return ClosureOut(
        closure_id=c.closure_id,
        lot_id=c.lot_id,
        space_ids=c.space_ids,
        reason=c.reason,
        starts_at=c.starts_at,
        ends_at=c.ends_at,
        created_by=c.created_by,
        created_at=c.created_at,
        ended_at=c.ended_at,
        active=c.is_active(now),
    )


@router.get(
    "",
    response_model=list[ClosureOut],
    responses={**_AUTH, 404: {"model": ErrorResponse}},
    summary="Every closure for a lot, including ended ones, latest start first",
)
def list_closures(
    lot_id: str, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> list[ClosureOut]:
    repo = adapters.repository
    if repo.get_lot(lot_id) is None:
        raise error(404, "not_found", "Lot not found")
    closures = sorted(repo.list_closures(lot_id), key=lambda c: c.starts_at, reverse=True)
    return [closure_out(c, now) for c in closures]


@router.post(
    "",
    response_model=ClosureOut,
    status_code=201,
    responses={
        **_AUTH,
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse, "description": "not_published: lot has no layout"},
        422: {
            "model": ErrorResponse,
            "description": "invalid_window, unknown_space, or validation_error",
        },
    },
    summary="Close spaces now, on a schedule, or until further notice",
)
def create_closure(
    lot_id: str, body: ClosureCreate, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> ClosureOut:
    repo = adapters.repository
    if repo.get_lot(lot_id) is None:
        raise error(404, "not_found", "Lot not found")
    if body.ends_at is not None and body.ends_at <= body.starts_at:
        raise error(422, "invalid_window", "End time must be after start time")
    found = find_published(repo, lot_id)
    if found is None:
        raise error(409, "not_published", "Publish the lot before closing spaces")
    _, layout = found
    known = {s.space_id for s in layout.active_spaces()}
    unknown = next((sid for sid in body.space_ids if sid not in known), None)
    if unknown is not None:
        raise error(422, "unknown_space", f"Unknown or retired space: {unknown}")
    closure = Closure(
        lot_id=lot_id,
        closure_id="cl_" + secrets.token_hex(6),
        space_ids=body.space_ids,
        reason=body.reason,
        starts_at=body.starts_at,
        ends_at=body.ends_at,
        created_by=admin.email,
        created_at=now,
    )
    repo.put_closure(closure)
    return closure_out(closure, now)


@router.delete(
    "/{closure_id}",
    response_model=ClosureOut,
    responses={
        **_AUTH,
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse, "description": "already_ended"},
    },
    summary="End a closure now; the record is kept",
)
def end_closure(
    lot_id: str, closure_id: str, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> ClosureOut:
    repo = adapters.repository
    closure = next((c for c in repo.list_closures(lot_id) if c.closure_id == closure_id), None)
    if closure is None:
        raise error(404, "not_found", "Closure not found")
    if closure.ended_at is not None or (closure.ends_at is not None and closure.ends_at <= now):
        raise error(409, "already_ended", "This closure has already ended")
    ended = closure.model_copy(update={"ended_at": now})
    repo.put_closure(ended)
    return closure_out(ended, now)
