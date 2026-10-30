"""Admin lots: list every lot (published or not) and create a new one (US-16)."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator
from datetime import datetime
from itertools import count

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


# `/admin/lots/new` is the New Lot page, so a lot can never have that id.
RESERVED_LOT_IDS = frozenset({"new"})


def candidate_lot_ids(name: str) -> Iterator[str]:
    """The name's slug, then `-2`, `-3`, ... (skipping reserved ids)."""
    base = slugify(name)
    for n in count(1):
        lot_id = base if n == 1 else f"{base}-{n}"
        if lot_id not in RESERVED_LOT_IDS:
            yield lot_id


def create_unique_lot(repo: Repository, body: AdminLotCreate, now: datetime) -> Lot:
    """Create the lot under the first free candidate id. The create is conditional, so a
    concurrent create of the same id moves this one to the next suffix instead of
    overwriting it."""
    lots = (
        Lot(
            lot_id=lot_id,
            name=body.name,
            location=body.location,
            stale_after_minutes=body.stale_after_minutes,
            created_at=now,
        )
        for lot_id in candidate_lot_ids(body.name)
    )
    return next(lot for lot in lots if repo.put_lot_if_absent(lot))


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
    # Best-effort: two creates of one name racing past this check both succeed, under
    # different ids. Accepted for an admin-only form; ids themselves never collide.
    if any(name_key(lot.name) == name_key(body.name) for lot in repo.list_lots()):
        raise error(409, "duplicate_lot_name", DUPLICATE_MESSAGE)
    lot = create_unique_lot(repo, body, now)
    ensure_draft_meta(repo, lot, now)
    return lot_out(lot)
