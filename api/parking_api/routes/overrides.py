"""Admin state overrides: an admin sets spaces Free or Occupied, shown to drivers over what the
cameras report until it ends (a closure still wins). List, create, end early."""

from __future__ import annotations

import secrets
from datetime import datetime

from fastapi import APIRouter
from parking_core.models import SpaceState, StateOverride

from ..deps import AdaptersDep, AdminDep, NowDep, error
from ..overrides_schemas import OverrideCreate, OverrideOut
from ..schemas import ErrorResponse
from .public import find_published

router = APIRouter(prefix="/admin/lots/{lot_id}/overrides", tags=["admin"])

_AUTH = {401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}}


def _status(o: StateOverride, now: datetime) -> str:
    if o.ended_at is not None or (o.ends_at is not None and o.ends_at <= now):
        return "ENDED"
    return "ACTIVE" if o.starts_at <= now else "SCHEDULED"


def override_out(o: StateOverride, now: datetime) -> OverrideOut:
    return OverrideOut(
        override_id=o.override_id,
        lot_id=o.lot_id,
        space_ids=o.space_ids,
        state=o.state.value,  # type: ignore[arg-type]
        note=o.note,
        starts_at=o.starts_at,
        ends_at=o.ends_at,
        created_by=o.created_by,
        created_at=o.created_at,
        ended_at=o.ended_at,
        active=o.is_active(now),
        status=_status(o, now),  # type: ignore[arg-type]
    )


@router.get(
    "",
    response_model=list[OverrideOut],
    responses={**_AUTH, 404: {"model": ErrorResponse}},
    summary="Every state override for a lot, including ended ones, latest start first",
)
def list_overrides(
    lot_id: str, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> list[OverrideOut]:
    repo = adapters.repository
    if repo.get_lot(lot_id) is None:
        raise error(404, "not_found", "Lot not found")
    overrides = sorted(repo.list_overrides(lot_id), key=lambda o: o.override_id)
    overrides.sort(key=lambda o: o.starts_at, reverse=True)  # stable: ties stay by id
    return [override_out(o, now) for o in overrides]


@router.post(
    "",
    response_model=OverrideOut,
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
    summary="Set spaces Free or Occupied over the cameras, now or on a schedule",
)
def create_override(
    lot_id: str, body: OverrideCreate, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> OverrideOut:
    repo = adapters.repository
    if repo.get_lot(lot_id) is None:
        raise error(404, "not_found", "Lot not found")
    # Now, by the server's clock; a start in the past means now too.
    starts_at = max(body.starts_at or now, now)
    if body.ends_at is not None and body.ends_at <= starts_at:
        raise error(422, "invalid_window", "End time must be after start time")
    found = find_published(repo, lot_id)
    if found is None:
        raise error(409, "not_published", "Publish the lot before setting space states")
    _, layout = found
    known = {s.space_id for s in layout.active_spaces()}
    unknown = next((sid for sid in body.space_ids if sid not in known), None)
    if unknown is not None:
        raise error(422, "unknown_space", f"Unknown or retired space: {unknown}")
    override = StateOverride(
        lot_id=lot_id,
        override_id="ov_" + secrets.token_hex(6),
        space_ids=body.space_ids,
        state=SpaceState(body.state),
        note=body.note.strip(),
        starts_at=starts_at,
        ends_at=body.ends_at,
        created_by=admin.email,
        created_at=now,
    )
    repo.put_override(override)
    return override_out(override, now)


@router.delete(
    "/{override_id}",
    response_model=OverrideOut,
    responses={
        **_AUTH,
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse, "description": "already_ended"},
    },
    summary="End an override now (the cameras decide again); the record is kept",
)
def end_override(
    lot_id: str, override_id: str, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> OverrideOut:
    repo = adapters.repository
    found = next((o for o in repo.list_overrides(lot_id) if o.override_id == override_id), None)
    if found is None:
        raise error(404, "not_found", "Override not found")
    if found.ended_at is not None or (found.ends_at is not None and found.ends_at <= now):
        raise error(409, "already_ended", "This override has already ended")
    ended = found.model_copy(update={"ended_at": now})
    repo.put_override(ended)
    return override_out(ended, now)
