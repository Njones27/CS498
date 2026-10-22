"""Lot status assembly (HDD §6.2) and the `/lots` summary. Pure functions, no I/O.

Returns plain dicts with the camelCase keys of `parking_api.schemas.LotStatusOut` and
`LotSummary`; the API validates them into its schema types.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from .models import (
    Closure,
    JobStatus,
    Lot,
    PublishedLayout,
    Snapshot,
    SpaceState,
    SpaceStatus,
)

_IN_FLIGHT = {JobStatus.QUEUED, JobStatus.PROCESSING}


def _space_rows(
    lot: Lot,
    layout: PublishedLayout,
    statuses: Iterable[SpaceStatus],
    closures: Iterable[Closure],
    now: datetime,
) -> list[dict[str, Any]]:
    by_space = {s.space_id: s for s in statuses}
    closed: dict[str, Closure] = {}
    for c in closures:
        if c.is_active(now):
            for sid in c.space_ids:
                closed.setdefault(sid, c)
    max_age = timedelta(minutes=lot.stale_after_minutes)
    rows = []
    for space in layout.active_spaces():
        st = by_space.get(space.space_id)
        closure = closed.get(space.space_id)
        observed_at = st.observed_at if st else None
        if closure is not None:
            state = SpaceState.CLOSED
            stale = False
        else:
            state = st.state if st else SpaceState.UNKNOWN
            stale = observed_at is None or now - observed_at > max_age
        rows.append(
            {
                "spaceId": space.space_id,
                "state": state,
                "observedAt": observed_at,
                "score": st.confidence if st else None,
                "stale": stale,
                "closure": (
                    {"reason": closure.reason, "endsAt": closure.ends_at} if closure else None
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
    latest_snapshot: Snapshot | None,
    now: datetime,
) -> dict[str, Any]:
    rows = _space_rows(lot, layout, statuses, closures, now)
    observed = [r["observedAt"] for r in rows if r["observedAt"] is not None]
    last_observed = max(observed) if observed else None
    processing = (
        latest_snapshot is not None
        and latest_snapshot.job_status in _IN_FLIGHT
        and (last_observed is None or latest_snapshot.capture_time > last_observed)
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
) -> dict[str, Any]:
    rows = _space_rows(lot, layout, statuses, closures, now)
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
