"""Draft layouts and publishing (US-07 #7, US-09).

The draft is the only editable copy of a lot's layout: its header is a `DraftMeta` item and
its spaces and viewpoints are the lot's SPACE# / VIEW# items. Drivers and the worker only
read published snapshots, so draft edits never reach them until a publish.
"""

from __future__ import annotations

from datetime import datetime

from .errors import NotPublishedError
from .interfaces import ObjectStore, Repository
from .models import DraftMeta, Lot, PublishedLayout, Schematic


def current_published(repo: Repository, lot_id: str) -> PublishedLayout | None:
    """The lot's current layout, or None when unpublished or its snapshot is missing."""
    try:
        return repo.get_published_layout(lot_id)
    except NotPublishedError:
        return None


def new_draft_meta(lot: Lot, published: PublishedLayout | None, now: datetime) -> DraftMeta:
    """Revision 0, based on the current published version, with its schematic size
    (or the 1000x600 default when the lot was never published)."""
    return DraftMeta(
        lot_id=lot.lot_id,
        schematic=published.schematic.model_copy() if published else Schematic(),
        revision=0,
        based_on_version=published.version if published else None,
        updated_at=now,
    )


def ensure_draft_meta(repo: Repository, lot: Lot, now: datetime) -> DraftMeta:
    """The lot's draft meta, created on first use (a lot with spaces seeded but no meta yet)."""
    meta = repo.get_draft_meta(lot.lot_id)
    if meta is not None:
        return meta
    meta = new_draft_meta(lot, current_published(repo, lot.lot_id), now)
    if repo.put_draft_meta(meta, expected_revision=None):
        return meta
    # Another request created it between our read and write: use theirs.
    return repo.get_draft_meta(lot.lot_id) or meta


def published_space_ids(repo: Repository, store: ObjectStore, lot_id: str) -> set[str]:
    """Every space id in any published version of the lot (retired ones included).

    Those spaces can be retired but never deleted, so old snapshots and observations stay
    valid. A missing snapshot object raises KeyError rather than letting a delete through.
    """
    ids: set[str] = set()
    for version in repo.list_layout_versions(lot_id):
        layout = PublishedLayout.model_validate_json(store.get(version.snapshot_key))
        ids.update(s.space_id for s in layout.spaces)
    return ids
