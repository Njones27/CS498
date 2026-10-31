"""One state per space from every viewpoint's latest reading (the server's truth for drivers).

Each viewpoint keeps its own latest reading of a space (`SpaceStatus`, one per space and view),
so a photo from one view never overwrites another view's reading. `fuse` combines them with
fixed rules, so views complement each other instead of the latest photo always winning:

1. Only readings within the lot's allowed data age of the space's newest reading count.
2. Free and Occupied are confident; Unknown is not. With no confident reading, the newest
   reading (Unknown) stands.
3. Otherwise the newest confident reading decides, except that a Free is overruled by an
   Occupied from another viewpoint within `AGREEMENT_WINDOW` of it: views seeing the lot at
   nearly the same moment that disagree resolve to Occupied, since a false Free is the costly
   error (HDD §4.5).
4. A newer Unknown from another viewpoint (one that sees the space badly) never replaces a
   confident reading. Within one viewpoint, its newer reading replaces its older one as before.

Pure: no I/O, no clock.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import timedelta

from .models import SpaceState, SpaceStatus

AGREEMENT_WINDOW = timedelta(minutes=10)
"""Readings from different viewpoints this close in time are taken as the same moment."""

_CONFIDENT = {SpaceState.FREE, SpaceState.OCCUPIED}


@dataclass(frozen=True)
class Fused:
    """The state a space shows, and the reading behind it (its time drives staleness)."""

    state: SpaceState
    reading: SpaceStatus
    views: tuple[str, ...]
    """Viewpoints whose counted readings agree with `state` (sorted; legacy readings, which
    have no viewpoint, are left out)."""


def fuse(readings: Iterable[SpaceStatus], allowed_age: timedelta) -> Fused | None:
    """The fused state of one space from its readings (any order); None without readings."""
    all_readings = list(readings)
    if not all_readings:
        return None
    newest = max(r.observed_at for r in all_readings)
    counted = [r for r in all_readings if newest - r.observed_at <= allowed_age]
    confident = [r for r in counted if r.state in _CONFIDENT]
    if not confident:
        latest = max(counted, key=_order)
        return Fused(latest.state, latest, _views(counted, latest.state))
    chosen = max(confident, key=_order)
    state = chosen.state
    if state is SpaceState.FREE:
        occupied = [
            r
            for r in confident
            if r.state is SpaceState.OCCUPIED
            and r.view_id is not None  # a legacy reading's view is unknown: maybe this one
            and r.view_id != chosen.view_id
            and abs(r.observed_at - chosen.observed_at) <= AGREEMENT_WINDOW
        ]
        if occupied:
            chosen = max(occupied, key=_order)
            state = SpaceState.OCCUPIED
    return Fused(state, chosen, _views(counted, state))


def fuse_by_space(readings: Iterable[SpaceStatus], allowed_age: timedelta) -> dict[str, Fused]:
    """`fuse` for every space in `readings`, keyed by space id."""
    by_space: dict[str, list[SpaceStatus]] = {}
    for r in readings:
        by_space.setdefault(r.space_id, []).append(r)
    out = {}
    for space_id, rs in by_space.items():
        fused = fuse(rs, allowed_age)
        if fused is not None:
            out[space_id] = fused
    return out


def _order(r: SpaceStatus) -> tuple:
    """Newest first; ties by layout version, then viewpoint, so the choice never depends on
    storage order."""
    return (r.observed_at, r.layout_version or 0, r.view_id or "")


def _views(readings: list[SpaceStatus], state: SpaceState) -> tuple[str, ...]:
    return tuple(sorted({r.view_id for r in readings if r.state is state and r.view_id}))
