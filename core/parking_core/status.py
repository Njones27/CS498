"""Lot status assembly (HDD §6.2) and the `/lots` summary. Pure functions, no I/O.

Returns plain dicts with the camelCase keys of `parking_api.schemas.LotStatusOut` and
`LotSummary`; the API validates them into its schema types.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from .fusion import fuse_by_space
from .models import (
    Closure,
    JobStatus,
    Lot,
    PublishedLayout,
    Snapshot,
    SpaceState,
    SpaceStatus,
    StateOverride,
)

_IN_FLIGHT = {JobStatus.QUEUED, JobStatus.PROCESSING}


def _closure_precedence(c: Closure) -> tuple[bool, float, str]:
    """Which of several overlapping closures a space shows: open-ended first, then the
    latest endsAt, then closure_id, so the choice never depends on storage order."""
    return (c.ends_at is not None, -c.ends_at.timestamp() if c.ends_at else 0.0, c.closure_id)


def _space_rows(
    lot: Lot,
    layout: PublishedLayout,
    statuses: Iterable[SpaceStatus],
    closures: Iterable[Closure],
    now: datetime,
    overrides: Iterable[StateOverride] = (),
) -> list[dict[str, Any]]:
    """Each active space's row. Precedence: a closure, then an admin override, then the state
    fused from every viewpoint's latest reading (`fusion.fuse`)."""
    max_age = timedelta(minutes=lot.stale_after_minutes)
    fused = fuse_by_space(statuses, max_age)
    active = sorted((c for c in closures if c.is_active(now)), key=_closure_precedence)
    closed: dict[str, Closure] = {}
    for c in active:
        for sid in c.space_ids:
            closed.setdefault(sid, c)
    pinned: dict[str, StateOverride] = {}
    # Overlapping overrides: the latest start wins, then the highest id (never storage order).
    newest_first = sorted(
        (o for o in overrides if o.is_active(now)),
        key=lambda o: (o.starts_at, o.override_id),
        reverse=True,
    )
    for o in newest_first:
        for sid in o.space_ids:
            pinned.setdefault(sid, o)
    rows = []
    for space in layout.active_spaces():
        f = fused.get(space.space_id)
        closure = closed.get(space.space_id)
        override = pinned.get(space.space_id)
        observed_at = f.reading.observed_at if f else None
        if closure is not None:
            state, stale, source = SpaceState.CLOSED, False, "closure"
        elif override is not None:
            state, stale, source = override.state, False, "admin"
        else:
            state = f.state if f else SpaceState.UNKNOWN
            stale = observed_at is None or now - observed_at > max_age
            source = "camera" if f else None
        rows.append(
            {
                "spaceId": space.space_id,
                "state": state,
                "observedAt": observed_at,
                "score": f.reading.confidence if f else None,
                "stale": stale,
                "source": source,
                "views": list(f.views) if f else [],
                "closure": (
                    {"reason": closure.reason, "endsAt": closure.ends_at} if closure else None
                ),
                "override": (
                    {"state": override.state, "endsAt": override.ends_at, "note": override.note}
                    if override and not closure
                    else None
                ),
            }
        )
    return rows


def _counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"free": 0, "occupied": 0, "unknown": 0, "closed": 0}
    for r in rows:
        counts[str(r["state"]).lower()] += 1
    return counts


def _is_stale(rows: list[dict[str, Any]]) -> bool:
    """A nonclosed space has an observation older than allowed (no data is not 'stale')."""
    return any(r["state"] != SpaceState.CLOSED and r["observedAt"] and r["stale"] for r in rows)


def build_status(
    lot: Lot,
    layout: PublishedLayout,
    statuses: Iterable[SpaceStatus],
    closures: Iterable[Closure],
    recent_snapshots: Iterable[Snapshot],
    now: datetime,
    overrides: Iterable[StateOverride] = (),
) -> dict[str, Any]:
    """`recent_snapshots` are the lot's newest captures (any order). Any of them still queued
    or processing and captured after the newest observation sets `processing`, so a newer
    photo that was abandoned or failed does not hide an older one still in flight."""
    rows = _space_rows(lot, layout, statuses, closures, now, overrides)
    observed = [r["observedAt"] for r in rows if r["observedAt"] is not None]
    last_observed = max(observed) if observed else None
    processing = any(
        s.job_status in _IN_FLIGHT and (last_observed is None or s.capture_time > last_observed)
        for s in recent_snapshots
    )
    return {
        "lotId": lot.lot_id,
        "lastObservedAt": last_observed,
        "isStale": _is_stale(rows),
        "processing": processing,
        "noObservations": not observed,
        "layoutVersion": layout.version,
        "spaces": rows,
        "counts": _counts(rows),
    }


def lot_summary(
    lot: Lot,
    layout: PublishedLayout,
    statuses: Iterable[SpaceStatus],
    closures: Iterable[Closure],
    now: datetime,
    overrides: Iterable[StateOverride] = (),
) -> dict[str, Any]:
    rows = _space_rows(lot, layout, statuses, closures, now, overrides)
    counts = _counts(rows)
    total = len(rows) - counts["closed"]
    has_recent = any(
        r["state"] != SpaceState.CLOSED and r["observedAt"] and not r["stale"] for r in rows
    )
    open_percent = round(counts["free"] / total * 100) if has_recent and total > 0 else None
    return {
        **counts,
        "total": total,
        "openPercent": open_percent,
        "isStale": _is_stale(rows),
        "hasRecentData": has_recent,
    }
