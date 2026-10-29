"""Admin lots: list every lot (published or not) and create a new one (US-16)."""

from __future__ import annotations

import re
import unicodedata

from fastapi import APIRouter
from parking_core.interfaces import Repository
from parking_core.layouts import ensure_draft_meta
from parking_core.models import Lot

from ..deps import AdaptersDep, AdminDep, NowDep, error
from ..lots_admin_schemas import AdminLotCreate, AdminLotOut
from ..schemas import ErrorResponse

router = APIRouter(prefix="/admin/lots", tags=["admin"])

_AUTH = {401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}}

DUPLICATE_MESSAGE = "A lot with this name already exists"


def slugify(name: str) -> str:
    """`"North Lot"` -> `north-lot`. Accents are folded to ASCII; a name with no letters or
    digits left falls back to `lot`."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-") or "lot"


def unique_lot_id(repo: Repository, name: str) -> str:
    """The name's slug, with `-2`, `-3`, ... appended while that id is taken."""
    base = slugify(name)
    lot_id, n = base, 1
    while repo.get_lot(lot_id) is not None:
        n += 1
        lot_id = f"{base}-{n}"
    return lot_id


def name_key(name: str) -> str:
    return name.strip().casefold()


def lot_out(lot: Lot) -> AdminLotOut:
    return AdminLotOut(
        lot_id=lot.lot_id,
        name=lot.name,
        location=lot.location,
        stale_after_minutes=lot.stale_after_minutes,
        published=lot.current_layout_version is not None,
        layout_version=lot.current_layout_version,
        created_at=lot.created_at,
    )


@router.get(
    "",
    response_model=list[AdminLotOut],
    responses=_AUTH,
    summary="Every lot, published or not, sorted by name",
)
def list_admin_lots(admin: AdminDep, adapters: AdaptersDep) -> list[AdminLotOut]:
    lots = sorted(adapters.repository.list_lots(), key=lambda lot: (lot.name.lower(), lot.lot_id))
    return [lot_out(lot) for lot in lots]


@router.post(
    "",
    response_model=AdminLotOut,
    status_code=201,
    responses={
        **_AUTH,
        409: {"model": ErrorResponse, "description": "duplicate_lot_name"},
        422: {"model": ErrorResponse, "description": "validation_error"},
    },
    summary="Create an unpublished lot with an empty draft layout",
)
def create_lot(
    body: AdminLotCreate, admin: AdminDep, adapters: AdaptersDep, now: NowDep
) -> AdminLotOut:
    repo = adapters.repository
    if any(name_key(lot.name) == name_key(body.name) for lot in repo.list_lots()):
        raise error(409, "duplicate_lot_name", DUPLICATE_MESSAGE)
    lot = Lot(
        lot_id=unique_lot_id(repo, body.name),
        name=body.name,
        location=body.location,
        stale_after_minutes=body.stale_after_minutes,
        created_at=now,
    )
    repo.put_lot(lot)
    ensure_draft_meta(repo, lot, now)
    return lot_out(lot)
