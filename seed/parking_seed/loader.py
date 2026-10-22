"""Idempotent lot loading (US-14 #6). Used by seed/seed.py and by tests with memory adapters."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from parking_core import keys
from parking_core.models import (
    LayoutVersion,
    Lot,
    ParkingSpace,
    PublishedLayout,
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
        return f"Loaded {self.name} with {self.spaces} spaces and {self.viewpoints} viewpoints"


def load_lot_file(lot_id: str, lots_dir: Path = LOTS_DIR) -> dict:
    return json.loads((lots_dir / f"{lot_id}.json").read_text())


def seed_lot(
    adapters: Adapters,
    data: dict,
    reference_image: bytes | None = None,
) -> SeedResult:
    """Upsert the lot, spaces and viewpoints; publish v1 only if nothing is published yet."""
    repo, store = adapters.repository, adapters.object_store
    lot_id = data["lotId"]
    now = utcnow()
    existing = repo.get_lot(lot_id)
    lot = Lot(
        lot_id=lot_id,
        name=data["name"],
        location=data.get("location", ""),
        stale_after_minutes=data.get("staleAfterMinutes", 30),
        current_layout_version=existing.current_layout_version if existing else None,
        created_at=existing.created_at if existing else now,
    )
    spaces = [ParkingSpace.model_validate({**s, "lotId": lot_id}) for s in data["spaces"]]
    ref_sha = hashlib.sha256(reference_image).hexdigest() if reference_image is not None else ""
    viewpoints = []
    for v in data["viewpoints"]:
        vp = Viewpoint.model_validate({**v, "lotId": lot_id})
        if reference_image is not None:
            ref_key = keys.reference_image_key(lot_id, vp.view_id, ref_sha)
            store.put(ref_key, reference_image, "image/jpeg")
            vp.reference_image_key = ref_key
        viewpoints.append(vp)

    repo.put_lot(lot)
    repo.put_spaces(spaces)
    for vp in viewpoints:
        repo.put_viewpoint(vp)

    created = lot.current_layout_version is None
    version = lot.current_layout_version or 1
    if created:
        snapshot_key = keys.layout_snapshot_key(lot_id, version)
        layout = PublishedLayout(
            lot_id=lot_id,
            version=version,
            schematic=Schematic.model_validate(data.get("schematic", {})),
            spaces=spaces,
            viewpoints=viewpoints,
            published_at=now,
            published_by=SEEDED_BY,
        )
        store.put(snapshot_key, layout.model_dump_json().encode(), "application/json")
        repo.publish_layout(
            lot_id,
            LayoutVersion(
                lot_id=lot_id,
                version=version,
                published_by=SEEDED_BY,
                published_at=now,
                snapshot_key=snapshot_key,
            ),
        )
    return SeedResult(
        lot_id=lot_id,
        name=lot.name,
        spaces=len(spaces),
        viewpoints=len(viewpoints),
        published_version=version,
        created=created,
    )
