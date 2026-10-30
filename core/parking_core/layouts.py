"""Draft layouts, validation and publishing (US-07 #7, US-09).

The draft is the only editable copy of a lot's layout: its header is a `DraftMeta` item and
its spaces and viewpoints are the lot's SPACE# / VIEW# items. Drivers and the worker only
read published snapshots, so draft edits never reach them until a publish.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from pydantic import Field

from . import keys
from .errors import NotPublishedError
from .interfaces import ObjectStore, Repository
from .models import (
    CamelModel,
    DraftMeta,
    LayoutVersion,
    Lot,
    OutlineStatus,
    ParkingSpace,
    Point,
    PublishedLayout,
    Rect,
    Schematic,
    Viewpoint,
)


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
        ids.update(s.space_id for s in read_version(store, version).spaces)
    return ids


def read_version(store: ObjectStore, version: LayoutVersion) -> PublishedLayout:
    return PublishedLayout.model_validate_json(store.get(version.snapshot_key))


@dataclass
class Draft:
    """A whole draft: its header plus the lot's SPACE# and VIEW# items."""

    meta: DraftMeta
    spaces: list[ParkingSpace]
    viewpoints: list[Viewpoint]


def load_draft(repo: Repository, lot: Lot, now: datetime) -> Draft:
    meta = ensure_draft_meta(repo, lot, now)
    return Draft(meta, repo.list_spaces(lot.lot_id), repo.list_viewpoints(lot.lot_id))


# --- Validation (brief §8.4) -----------------------------------------------------


class Issue(CamelModel):
    code: str = Field(description="Machine-readable rule, e.g. duplicate_label")
    message: str
    space_ids: list[str] = Field(description="Spaces the issue is about; may be empty")
    view_id: str | None = Field(description="The viewpoint the issue is about, if any")


class LayoutDiff(CamelModel):
    """Space ids that change for drivers and the worker if this draft is published."""

    added: list[str]
    retired: list[str]
    changed: list[str] = Field(description="Rect, label, type or outlines differ")


class ValidationReport(CamelModel):
    ok: bool = Field(description="True when there are no errors; warnings never block")
    errors: list[Issue]
    warnings: list[Issue]
    compared_with: int | None = Field(description="Published version the diff is against")
    diff: LayoutDiff


_EPS = 1e-9


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def _name(space: ParkingSpace | None, space_id: str) -> str:
    """What the admin calls a space: its label, else its id."""
    label = space.label.strip() if space else ""
    return label or space_id


def _cross(o: Point, a: Point, b: Point) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _on_segment(p: Point, q: Point, r: Point) -> bool:
    """r lies within the bounding box of segment pq (call only when the three are collinear)."""
    return (
        min(p[0], q[0]) - _EPS <= r[0] <= max(p[0], q[0]) + _EPS
        and min(p[1], q[1]) - _EPS <= r[1] <= max(p[1], q[1]) + _EPS
    )


def _segments_touch(p1: Point, p2: Point, q1: Point, q2: Point) -> bool:
    """True if the closed segments p1p2 and q1q2 share any point."""
    d1, d2 = _cross(q1, q2, p1), _cross(q1, q2, p2)
    d3, d4 = _cross(p1, p2, q1), _cross(p1, p2, q2)
    if ((d1 > _EPS and d2 < -_EPS) or (d1 < -_EPS and d2 > _EPS)) and (
        (d3 > _EPS and d4 < -_EPS) or (d3 < -_EPS and d4 > _EPS)
    ):
        return True
    return (
        (abs(d1) <= _EPS and _on_segment(q1, q2, p1))
        or (abs(d2) <= _EPS and _on_segment(q1, q2, p2))
        or (abs(d3) <= _EPS and _on_segment(p1, p2, q1))
        or (abs(d4) <= _EPS and _on_segment(p1, p2, q2))
    )


def is_valid_quad(polygon: list[Point]) -> bool:
    """Four corners, non-zero area, and no edge crossing or touching the opposite edge.

    Concave four-sided shapes are fine. A repeated corner makes two opposite edges touch,
    so it is rejected too."""
    if len(polygon) != 4:
        return False
    a, b, c, d = (tuple(p) for p in polygon)
    area2 = sum(_cross((0.0, 0.0), p, q) for p, q in ((a, b), (b, c), (c, d), (d, a)))
    if abs(area2) <= _EPS:
        return False
    return not (_segments_touch(a, b, c, d) or _segments_touch(b, c, d, a))


def _inside_photo(polygon: list[Point]) -> bool:
    return all(0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 for x, y in polygon)


def _is_valid_rect(rect: Rect) -> bool:
    """Finite, with positive width and height. `Rect` rejects non-finite numbers, but a draft
    stored before it did (or built in code) can still hold them."""
    values = (rect.x, rect.y, rect.w, rect.h)
    return all(math.isfinite(v) for v in values) and rect.w > 0 and rect.h > 0


def _views_text(view_ids: list[str]) -> str:
    if len(view_ids) == 1:
        return view_ids[0]
    return f"{', '.join(view_ids[:-1])} and {view_ids[-1]}"


def validate_draft(draft: Draft, published: PublishedLayout | None) -> ValidationReport:
    """Check a draft before publishing (US-09 #1-#3). Pure: reads nothing but its arguments.

    Errors block publishing; warnings are shown and don't. Issues come in rule order (the
    tables in brief §8.4), then by space id."""
    errors: list[Issue] = []
    warnings: list[Issue] = []
    by_id = {s.space_id: s for s in draft.spaces}
    active = sorted((s for s in draft.spaces if not s.retired), key=lambda s: s.space_id)
    views = sorted(draft.viewpoints, key=lambda v: v.view_id)

    def err(code: str, message: str, space_ids: Iterable[str] = (), view_id: str | None = None):
        errors.append(Issue(code=code, message=message, space_ids=list(space_ids), view_id=view_id))

    def warn(code: str, message: str, space_ids: Iterable[str] = (), view_id: str | None = None):
        warnings.append(
            Issue(code=code, message=message, space_ids=list(space_ids), view_id=view_id)
        )

    # duplicate_label / empty_label: active spaces only (retired labels may be reused).
    by_label: dict[str, list[ParkingSpace]] = defaultdict(list)
    blank: list[str] = []
    for s in active:
        label = s.label.strip()
        if label:
            by_label[label.casefold()].append(s)
        else:
            blank.append(s.space_id)
    for group in sorted(by_label.values(), key=lambda g: g[0].space_id):
        if len(group) > 1:
            count = "Two" if len(group) == 2 else str(len(group))
            label = group[0].label.strip()
            err(
                "duplicate_label",
                f"{count} spaces share the label {label}",
                (s.space_id for s in group),
            )
    if blank:
        n = len(blank)
        message = "A space has no label" if n == 1 else f"{n} spaces have no label"
        err("empty_label", message, blank)

    # Outline geometry, per viewpoint. Outlines of unknown spaces get only their own error.
    for v in views:
        unknown = sorted(sid for sid in v.outlines if sid not in by_id)
        for sid in sorted(v.outlines):
            if sid in by_id:
                poly = v.outlines[sid]
                if not _inside_photo(poly):
                    name = _name(by_id[sid], sid)
                    err(
                        "polygon_outside_photo",
                        f"{name} polygon is outside the {v.view_id} photo",
                        [sid],
                        v.view_id,
                    )
                if not is_valid_quad(poly):
                    name = _name(by_id[sid], sid)
                    err(
                        "bad_polygon",
                        f"{name} outline in {v.view_id} is not a valid four-sided shape",
                        [sid],
                        v.view_id,
                    )
        if unknown:
            message = (
                f"{v.view_id} has an outline for a space that does not exist"
                if len(unknown) == 1
                else f"{v.view_id} has outlines for {len(unknown)} spaces that do not exist"
            )
            err("outline_unknown_space", message, unknown, v.view_id)

    for v in views:
        if v.outlines and v.reference_image_key is None:
            err(
                "outlines_without_photo",
                f"{v.view_id} has outlines but no reference photo",
                sorted(v.outlines),
                v.view_id,
            )

    # A review entry whose outline was deleted is orphaned; it can't be reviewed, so it can't block.
    pending = [
        (v.view_id, sid)
        for v in views
        for sid, review in sorted(v.outline_review.items())
        if review.status is OutlineStatus.PENDING and sid in v.outlines
    ]
    if pending:
        n = len(pending)
        pending_views = {vid for vid, _ in pending}
        err(
            "pending_proposals",
            f"{n} proposed {_plural(n, 'outline is', 'outlines are')} still waiting for review",
            sorted({sid for _, sid in pending}),
            next(iter(pending_views)) if len(pending_views) == 1 else None,
        )

    # A bad rect gets only its own error: NaN compares False, so it would look inside.
    width, height = draft.meta.schematic.width, draft.meta.schematic.height
    for s in active:
        r = s.rect
        if not _is_valid_rect(r):
            err(
                "bad_rect",
                f"{_name(s, s.space_id)} is not a valid rectangle on the map",
                [s.space_id],
            )
        elif r.x < -_EPS or r.y < -_EPS or r.x + r.w > width + _EPS or r.y + r.h > height + _EPS:
            err(
                "rect_outside_schematic",
                f"{_name(s, s.space_id)} is outside the map area",
                [s.space_id],
            )

    if not active:
        err("no_active_spaces", "The layout has no spaces")

    # Warnings
    outlined = {sid for v in views for sid in v.outlines}
    unmapped = [s.space_id for s in active if s.space_id not in outlined]
    if unmapped:
        n = len(unmapped)
        warn(
            "unmapped_spaces",
            f"{n} {_plural(n, 'space has', 'spaces have')} no polygon in any view: "
            f"{_plural(n, 'it', 'they')} will show UNKNOWN",
            unmapped,
        )

    for s in sorted(draft.spaces, key=lambda s: s.space_id):
        in_views = [v.view_id for v in views if s.space_id in v.outlines] if s.retired else []
        if in_views:
            name = _name(s, s.space_id)
            warn(
                "retired_with_outlines",
                f"{name} is retired but still outlined in {_views_text(in_views)}",
                [s.space_id],
                in_views[0] if len(in_views) == 1 else None,
            )

    for v in views:
        if v.reference_image_key is not None and not v.outlines:
            warn(
                "viewpoint_without_outlines",
                f"{v.view_id} has no outlined spaces",
                view_id=v.view_id,
            )

    for i, a in enumerate(active):
        for b in active[i + 1 :]:
            if _rects_overlap(a, b):
                warn(
                    "overlapping_rects",
                    f"{_name(a, a.space_id)} and {_name(b, b.space_id)} overlap on the map",
                    [a.space_id, b.space_id],
                )

    return ValidationReport(
        ok=not errors,
        errors=errors,
        warnings=warnings,
        compared_with=published.version if published else None,
        diff=diff_draft(draft, published),
    )


def _rects_overlap(a: ParkingSpace, b: ParkingSpace) -> bool:
    """Overlap with positive area; rectangles that only share an edge don't count."""
    ra, rb = a.rect, b.rect
    dx = min(ra.x + ra.w, rb.x + rb.w) - max(ra.x, rb.x)
    dy = min(ra.y + ra.h, rb.y + rb.h) - max(ra.y, rb.y)
    return dx > _EPS and dy > _EPS


def _outlines_of(space_id: str, viewpoints: list[Viewpoint]) -> dict[str, tuple]:
    return {
        v.view_id: tuple(tuple(float(c) for c in p) for p in v.outlines[space_id])
        for v in viewpoints
        if space_id in v.outlines
    }


def diff_draft(draft: Draft, published: PublishedLayout | None) -> LayoutDiff:
    """What changes for drivers and the worker. A space that is active again after being
    retired counts as added; a retired space's own edits are not reported."""
    before = {s.space_id: s for s in published.active_spaces()} if published else {}
    before_views = published.viewpoints if published else []
    added: list[str] = []
    retired: list[str] = []
    changed: list[str] = []
    for s in sorted(draft.spaces, key=lambda s: s.space_id):
        old = before.get(s.space_id)
        if s.retired:
            if old is not None:
                retired.append(s.space_id)
        elif old is None:
            added.append(s.space_id)
        elif (
            old.label != s.label
            or old.space_type != s.space_type
            or old.rect != s.rect
            or _outlines_of(s.space_id, before_views) != _outlines_of(s.space_id, draft.viewpoints)
        ):
            changed.append(s.space_id)
    return LayoutDiff(added=added, retired=retired, changed=changed)


# --- Publish, versions and restore (brief §8.3, §4.3) ---------------------------------


class StaleRevisionError(Exception):
    """The draft was saved (or published) elsewhere since the caller loaded it."""


class ValidationFailedError(Exception):
    """The draft has validation errors, so it can't be published."""

    def __init__(self, report: ValidationReport) -> None:
        super().__init__("; ".join(i.message for i in report.errors))
        self.report = report


def build_layout(
    lot_id: str, version: int, draft: Draft, published_by: str, now: datetime
) -> PublishedLayout:
    """The snapshot for a draft: every space (retired ones included, so old observations stay
    explained), every viewpoint with its `reference_image_key` as-is, and the schematic."""
    return PublishedLayout(
        lot_id=lot_id,
        version=version,
        schematic=draft.meta.schematic.model_copy(),
        spaces=sorted(draft.spaces, key=lambda s: s.space_id),
        viewpoints=sorted(draft.viewpoints, key=lambda v: v.view_id),
        published_at=now,
        published_by=published_by,
    )


def write_layout(repo: Repository, store: ObjectStore, layout: PublishedLayout) -> LayoutVersion:
    """Write the snapshot JSON, then the LayoutVersion and the lot's pointer in one
    transaction (HDD §6.5). Drivers and the worker switch to it at that transaction."""
    snapshot_key = keys.layout_snapshot_key(layout.lot_id, layout.version)
    store.put(snapshot_key, layout.model_dump_json().encode(), "application/json")
    version = LayoutVersion(
        lot_id=layout.lot_id,
        version=layout.version,
        published_by=layout.published_by,
        published_at=layout.published_at,
        snapshot_key=snapshot_key,
    )
    repo.publish_layout(layout.lot_id, version)
    return version


def next_version(repo: Repository, lot_id: str) -> int:
    return max((v.version for v in repo.list_layout_versions(lot_id)), default=0) + 1


def publish_draft(
    repo: Repository,
    store: ObjectStore,
    lot: Lot,
    expected_revision: int,
    published_by: str,
    now: datetime,
) -> LayoutVersion:
    """Validate the stored draft and publish it as the next version (US-09 #4).

    Raises StaleRevisionError when the draft is not at `expected_revision`, and
    ValidationFailedError when it has errors. Before writing anything, the draft meta is
    moved to the next revision with `basedOnVersion` set to the new version, as a conditional
    write: of two publishes (or a publish and a save) racing on one revision, only one wins.
    """
    draft = load_draft(repo, lot, now)
    if draft.meta.revision != expected_revision:
        raise StaleRevisionError
    report = validate_draft(draft, current_published(repo, lot.lot_id))
    if not report.ok:
        raise ValidationFailedError(report)

    version = next_version(repo, lot.lot_id)
    claimed = draft.meta.model_copy(
        update={"revision": draft.meta.revision + 1, "based_on_version": version}
    )
    if not repo.put_draft_meta(claimed, expected_revision=draft.meta.revision):
        raise StaleRevisionError
    return write_layout(repo, store, build_layout(lot.lot_id, version, draft, published_by, now))


def list_versions(repo: Repository, lot_id: str) -> list[LayoutVersion]:
    """Newest first (US-09 #6)."""
    return sorted(repo.list_layout_versions(lot_id), key=lambda v: v.version, reverse=True)


def restore_version(
    repo: Repository,
    store: ObjectStore,
    lot: Lot,
    version: int,
    restored_by: str,
    now: datetime,
) -> Draft:
    """Replace the draft with a published version's contents (US-09 #7) and bump its revision.

    - Spaces another version published that this one lacks stay in the draft as retired,
      since published spaces are never deleted. Spaces never published are dropped.
    - Viewpoints this version lacks are kept (viewpoints are never removed) with no outlines.
    - `basedOnVersion` becomes the restored version.

    Raises LookupError for an unknown version and StaleRevisionError if the draft was saved
    while restoring, in which case nothing is written.
    """
    lot_id = lot.lot_id
    entry = next((v for v in repo.list_layout_versions(lot_id) if v.version == version), None)
    if entry is None:
        raise LookupError(f"Lot {lot_id!r} has no version {version}")
    layout = read_version(store, entry)
    draft = load_draft(repo, lot, now)

    restored_ids = {s.space_id for s in layout.spaces}
    published_ids = published_space_ids(repo, store, lot_id)
    extra = [s for s in draft.spaces if s.space_id not in restored_ids]
    kept = [s.model_copy(update={"retired": True}) for s in extra if s.space_id in published_ids]
    dropped = [s.space_id for s in extra if s.space_id not in published_ids]
    spaces = [s.model_copy(update={"lot_id": lot_id}) for s in layout.spaces] + kept

    restored_views = {v.view_id for v in layout.viewpoints}
    viewpoints = [v.model_copy(update={"lot_id": lot_id}) for v in layout.viewpoints] + [
        v.model_copy(update={"outlines": {}, "outline_review": {}})
        for v in draft.viewpoints
        if v.view_id not in restored_views
    ]

    # The meta first, as the claim (like a save or a publish), so a restore that loses to a save
    # writes nothing. A failure after the claim leaves a partly restored draft; restore again.
    meta = draft.meta.model_copy(
        update={
            "revision": draft.meta.revision + 1,
            "schematic": layout.schematic.model_copy(),
            "based_on_version": version,
            "updated_at": now,
            "updated_by": restored_by,
        }
    )
    if not repo.put_draft_meta(meta, expected_revision=draft.meta.revision):
        raise StaleRevisionError
    repo.put_spaces(spaces)
    for v in viewpoints:
        repo.put_viewpoint(v)
    for space_id in dropped:
        repo.delete_space(lot_id, space_id)
    return Draft(meta, spaces, viewpoints)
