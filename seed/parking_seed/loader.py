"""Idempotent lot loading (US-14 #6). Used by seed/seed.py and by tests with memory adapters."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from parking_core import keys
from parking_core.layouts import (
    Draft,
    ValidationFailedError,
    build_layout,
    next_version,
    validate_draft,
    write_layout,
)
from parking_core.models import (
    DraftMeta,
    Lot,
    ParkingSpace,
    Schematic,
    Viewpoint,
    utcnow,
)
from parking_core.settings import Adapters

REPO_ROOT = Path(__file__).resolve().parents[2]
LOTS_DIR = REPO_ROOT / "seed" / "lots"
FIXTURES_DIR = REPO_ROOT / "eval" / "fixtures"
DEFAULT_LOT = "test-lot"
SEEDED_BY = "seed"


@dataclass
class SeedResult:
    lot_id: str
    name: str
    spaces: int
    viewpoints: int
    published_version: int
    created: bool

    def summary(self) -> str:
        if not self.created:
            return f"{self.name} is already published (v{self.published_version}); left it as is"
        return f"Loaded {self.name} with {self.spaces} spaces and {self.viewpoints} viewpoints"


def load_lot_file(lot_id: str, lots_dir: Path = LOTS_DIR) -> dict:
    return json.loads((lots_dir / f"{lot_id}.json").read_text())


def seed_lot(
    adapters: Adapters,
    data: dict,
    reference_image: bytes | None = None,
) -> SeedResult:
    """Load a lot and publish it as v1, unless it is already published.

    A published lot is left alone, so re-running the seed never overwrites an admin's draft
    edits. The layout goes through the same validation as an admin's publish; a lot file
    with errors raises ValidationFailedError before anything is written.
    """
    repo, store = adapters.repository, adapters.object_store
    lot_id = data["lotId"]
    now = utcnow()
    existing = repo.get_lot(lot_id)
    if existing is not None and existing.current_layout_version is not None:
        return SeedResult(
            lot_id=lot_id,
            name=existing.name,
            spaces=len(repo.list_spaces(lot_id)),
            viewpoints=len(repo.list_viewpoints(lot_id)),
            published_version=existing.current_layout_version,
            created=False,
        )

    lot = Lot(
        lot_id=lot_id,
        name=data["name"],
        location=data.get("location", ""),
        stale_after_minutes=data.get("staleAfterMinutes", 30),
        created_at=existing.created_at if existing else now,
    )
    spaces = [ParkingSpace.model_validate({**s, "lotId": lot_id}) for s in data["spaces"]]
    ref_sha = hashlib.sha256(reference_image).hexdigest() if reference_image is not None else ""
    viewpoints = []
    for v in data["viewpoints"]:
        vp = Viewpoint.model_validate({**v, "lotId": lot_id})
        if reference_image is not None:
            vp.reference_image_key = keys.reference_image_key(lot_id, vp.view_id, ref_sha)
        viewpoints.append(vp)
    old_meta = repo.get_draft_meta(lot_id)
    meta = DraftMeta(
        lot_id=lot_id,
        schematic=Schematic.model_validate(data.get("schematic", {})),
        revision=old_meta.revision + 1 if old_meta else 0,
        updated_at=now,
    )
    draft = Draft(meta, spaces, viewpoints)
    report = validate_draft(draft, None)
    if not report.ok:
        raise ValidationFailedError(report)

    for vp in viewpoints:
        if reference_image is not None and vp.reference_image_key is not None:
            store.put(vp.reference_image_key, reference_image, "image/jpeg")
    repo.put_lot(lot)
    repo.put_spaces(spaces)
    for vp in viewpoints:
        repo.put_viewpoint(vp)
    version = next_version(repo, lot_id)
    if old_meta is not None:
        # An earlier seed stopped before publishing and someone opened the draft since: this
        # seed replaced its items, so move its revision on and point it at the new version.
        repo.put_draft_meta(
            meta.model_copy(update={"based_on_version": version}),
            expected_revision=old_meta.revision,
        )
    write_layout(repo, store, build_layout(lot_id, version, draft, SEEDED_BY, now))
    return SeedResult(
        lot_id=lot_id,
        name=lot.name,
        spaces=len(spaces),
        viewpoints=len(viewpoints),
        published_version=version,
        created=True,
    )
