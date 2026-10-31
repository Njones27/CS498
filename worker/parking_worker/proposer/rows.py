"""Rows of evenly spaced stalls, found in the divider frame (dividers vertical).

1. `stroke_masks`: vertical paint strokes (dividers) and horizontal ones (row lines).
2. `find_bands`: horizontal bands where dividers are, split at long row lines (a divider
   crossing a row line belongs to the two back-to-back rows it separates).
3. `column_peaks`: divider positions along each band (paint coverage per column).
4. `estimate_pitch`: the stall width shared by the lot, robust to missed dividers.
5. `select_dividers` + `row_stalls`: keep the dividers that fit a lattice and fill the
   missing ones, so every stall between the first and last divider is proposed.
6. `car_rows`: rows of parked cars with no paint at all.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import cv2
import numpy as np

from .cars import Car
from .frame import Frame

STROKE_LEN_FRAC = 0.015
"""A paint stroke must run at least this share of the photo's long side (and 3 line widths)."""
BAND_SHARE = 0.12
"""A frame row is inside a stall band when its divider paint is at least this share of the
busiest row's (and at least 2.5 line widths, about 2.5 dividers)."""
SPLIT_SHARE = 0.3
"""A row line splits a band when it covers this share of the band's width..."""
SPLIT_MARGIN = 0.2
"""...and lies at least this share of the band's height from either end."""
PEAK_MIN = 0.25
"""A divider must cover this share of its row's depth (cars and wear hide the rest)."""
PITCH_RANGE = (0.2, 1.0)
"""Stall width as a share of row depth that the pitch search considers."""
MIN_GAP = 0.65
"""Dividers closer than this many pitches cannot both be real."""
WIDE_STALL = 1.6
"""A gap up to this many pitches is one (wide) stall; beyond, it hides missed dividers."""
MAX_BLIND_FILL = 3
"""Longest run of stalls filled between two dividers with no car in between. Longer gaps are
more likely a cross aisle or an island than unpainted stalls."""
CARS_PER_FILL = 3
"""A longer gap is filled when it holds at least one car per this many stalls."""
MAX_EXTEND = 3
"""Stalls added past a row's last divider, one per car found there."""
MISFIT_WEIGHT = 1.0
SPLIT_DEPTH = 1.7
"""A band this many median row depths tall with no row line is split into equal rows."""
DOUBLE_ROW = 3.4
"""A band deeper than this many pitches is back-to-back rows with no row line painted (a
stall is about twice as deep as it is wide; one 3.4 times as deep is implausible)."""
ROW_SHAPE = 2.1
"""Typical stall depth in pitches, to count the rows hidden in such a band."""


@dataclass
class Band:
    """A row of stalls in the frame: ``y0``..``y1``. An open end is a row's aisle side (not a
    row line shared with a back-to-back row); only an open end can run off the photo."""

    y0: float
    y1: float
    top_open: bool = True
    bottom_open: bool = True

    @property
    def depth(self) -> float:
        return self.y1 - self.y0


@dataclass
class FrameStall:
    """One stall in the frame, with the paint strength of its two dividers (0 = filled in) and
    whether a car sits in it."""

    x0: float
    x1: float
    y0: float
    y1: float
    left: float
    right: float
    car: bool = False


def _kernel(w: int, h: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_RECT, (max(1, w), max(1, h)))


def stroke_len(stroke: float, side: int) -> int:
    return max(int(3 * stroke), round(STROKE_LEN_FRAC * side))


def stroke_masks(mask: np.ndarray, stroke: float, side: int) -> tuple[np.ndarray, np.ndarray]:
    """(vertical, horizontal) stroke masks: long thin paint in each direction.

    An opening with a long thin kernel keeps strokes along it; subtracting an opening with a
    short kernel across it (2 line widths and more) drops wide bright blobs such as white cars.
    """
    length = stroke_len(stroke, side)
    wide = int(2 * stroke + 3)
    vert = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _kernel(1, length))
    horiz = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _kernel(length, 1))
    blob_h = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _kernel(wide, 1))
    blob_v = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _kernel(1, wide))
    return vert & (1 - blob_h), horiz & (1 - blob_v)


def _smooth(profile: np.ndarray, width: float) -> np.ndarray:
    k = max(1, int(round(width)))
    return np.convolve(profile, np.ones(k) / k, mode="same")


def _runs(on: np.ndarray) -> list[tuple[int, int]]:
    """Half-open [start, end) runs of True."""
    padded = np.concatenate([[False], on, [False]]).astype(np.int8)
    edges = np.flatnonzero(np.diff(padded))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist(), strict=True))


def _local_peaks(profile: np.ndarray, window: int, floor: float) -> list[int]:
    """Indices of plateau-centred local maxima at least ``floor`` high."""
    k = max(3, window | 1)
    prof = profile.astype(np.float32)
    dil = cv2.dilate(prof.reshape(1, -1), np.ones((1, k), np.uint8))[0]
    top = (prof >= dil) & (prof >= floor)
    return [(a + b - 1) // 2 for a, b in _runs(top)]


def find_bands(vert: np.ndarray, horiz: np.ndarray, stroke: float, side: int) -> list[Band]:
    """Stall rows from the vertical stroke profile, split at row lines (top to bottom)."""
    pv = _smooth(vert.sum(axis=1).astype(np.float64), 2 * stroke)
    if pv.max() <= 0:
        return []
    thr = max(2.5 * stroke, BAND_SHARE * float(np.percentile(pv[pv > 0], 99)))
    runs = _runs(pv >= thr)
    merged: list[list[int]] = []
    for a, b in runs:
        if merged and a - merged[-1][1] < 2 * stroke:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    min_len = stroke_len(stroke, side)
    bands: list[Band] = []
    for a, b in merged:
        if b - a < min_len:
            continue
        cols = np.flatnonzero(vert[a:b].any(axis=0))
        if cols.size == 0:
            continue
        x0, x1 = int(np.percentile(cols, 1)), int(np.percentile(cols, 99)) + 1
        ph = horiz[a:b, x0:x1].sum(axis=1) / max(1, x1 - x0)
        cuts: list[float] = []
        margin = SPLIT_MARGIN * (b - a)
        for i in sorted(_local_peaks(ph, int(4 * stroke), SPLIT_SHARE), key=lambda i: -ph[i]):
            lo, hi = max(0, i - int(stroke)), min(len(ph), i + int(stroke) + 1)
            y = a + float(np.average(np.arange(lo, hi), weights=ph[lo:hi] + 1e-9))
            if y - a >= margin and b - y >= margin and all(abs(y - c) >= margin for c in cuts):
                cuts.append(y)
        edges = [float(a), *sorted(cuts), float(b)]
        for k in range(len(edges) - 1):
            bands.append(
                Band(edges[k], edges[k + 1], top_open=k == 0, bottom_open=k == len(edges) - 2)
            )
    return bands


def split_tall(
    bands: list[Band], depth: float | None = None, pitch: float | None = None
) -> list[Band]:
    """Split a band much taller than the typical row ``depth``, or than a stall ``pitch``
    wide can be deep: back-to-back rows with no row line seen."""
    out = []
    for band in bands:
        n = 1
        if depth and band.depth > SPLIT_DEPTH * depth:
            n = round(band.depth / depth)
        if pitch and band.depth > DOUBLE_ROW * pitch:
            n = max(n, round(band.depth / (ROW_SHAPE * pitch)))
        step = band.depth / max(n, 1)
        for k in range(max(n, 1)):
            out.append(
                Band(
                    band.y0 + k * step,
                    band.y0 + (k + 1) * step,
                    top_open=band.top_open if k == 0 else False,
                    bottom_open=band.bottom_open if k == n - 1 or n <= 1 else False,
                )
            )
    return out


def mask_cars(vert: np.ndarray, cars: Sequence[Car], stroke: float) -> np.ndarray:
    """Remove paint-like strokes on car bodies (white cars' roof and window edges).

    Only the car's middle is cleared, short of its box sides by two line widths: a box
    includes the mirrors, and the divider beside a parked car must survive."""
    if not cars:
        return vert
    out = vert.copy()
    h, w = out.shape
    for car in cars:
        hx = max(0.0, car.a / 2 - 2.0 * stroke)
        x0, x1 = max(0, int(car.cx - hx)), min(w, int(math.ceil(car.cx + hx)))
        y0, y1 = max(0, int(car.cy - car.b / 2)), min(h, int(math.ceil(car.cy + car.b / 2)))
        if x1 > x0 and y1 > y0:
            out[y0:y1, x0:x1] = 0
    return out


def column_peaks(vert: np.ndarray, band: Band, stroke: float) -> list[tuple[float, float]]:
    """Divider candidates in a band: (x, strength), strength = share of the depth painted."""
    y0, y1 = max(0, int(round(band.y0))), min(vert.shape[0], int(round(band.y1)))
    if y1 - y0 < 2:
        return []
    pc = vert[y0:y1].sum(axis=0).astype(np.float64) / (y1 - y0)
    smooth = _smooth(pc, stroke)
    out = []
    r = max(1, int(round(stroke)))
    for i in _local_peaks(smooth, int(2.5 * stroke), PEAK_MIN):
        lo, hi = max(0, i - r), min(len(pc), i + r + 1)
        weights = pc[lo:hi]
        x = float(np.average(np.arange(lo, hi), weights=weights)) if weights.sum() > 0 else i
        out.append((x + 0.5, float(min(1.0, smooth[i]))))
    return out


def estimate_pitch(
    peak_lists: Sequence[Sequence[tuple[float, float]]], depth: float
) -> float | None:
    """The lot's stall width from gaps between neighbouring dividers.

    Each candidate pitch d scores sum(fit / n) over all gaps, n = gaps / d rounded: a missed
    divider makes a gap of 2d (still fits, at half weight), so half the true pitch, which fits
    every gap as n = 2, loses to the true pitch. The winner is refined by a median.
    """
    gaps = np.concatenate(
        [np.diff(sorted(x for x, _ in peaks)) for peaks in peak_lists if len(peaks) > 1] or [[]]
    )
    lo, hi = PITCH_RANGE[0] * depth, PITCH_RANGE[1] * depth
    cands = gaps[(gaps >= lo) & (gaps <= hi)]
    if cands.size == 0:
        return None
    best_d, best_score = 0.0, -1.0
    for d in np.unique(np.round(cands, 1)):
        ratio = gaps / d
        n = np.round(ratio)
        ok = (n >= 1) & (n <= 4)
        score = float(np.sum(np.exp(-0.5 * ((ratio[ok] - n[ok]) / 0.07) ** 2) / n[ok]))
        if score > best_score:
            best_d, best_score = float(d), score
    ratio = gaps / best_d
    n = np.round(ratio)
    good = (n >= 1) & (n <= 4) & (np.abs(ratio - n) < 0.1)
    return float(np.median(gaps[good] / n[good])) if good.any() else best_d


def _misfit(ratio: float) -> float:
    """How badly a gap of ``ratio`` pitches fits the lattice (0 = perfectly)."""
    if ratio < 1.0:
        return 2.0 * (1.0 - ratio)
    if ratio <= WIDE_STALL:
        return 0.3 * (ratio - 1.0)
    if ratio > MAX_BLIND_FILL + 0.5:
        return 0.0  # a row break, judged later
    return 2.0 * abs(ratio - round(ratio))


def select_dividers(
    peaks: Sequence[tuple[float, float]], pitch: float
) -> list[tuple[float, float]]:
    """The subset of divider candidates that best fits an evenly spaced row.

    Dynamic programming over peaks left to right: a chain gains each kept divider's strength
    and pays for every gap that is not a whole number of pitches; gaps under `MIN_GAP` pitches
    are not allowed. Car edges and lamp posts between real dividers drop out.
    """
    pts = sorted(peaks)
    m = len(pts)
    if m == 0:
        return []
    best = [s for _, s in pts]
    prev = [-1] * m
    for j in range(m):
        for i in range(j):
            ratio = (pts[j][0] - pts[i][0]) / pitch
            if ratio < MIN_GAP:
                continue
            value = best[i] + pts[j][1] - MISFIT_WEIGHT * _misfit(ratio)
            if value > best[j]:
                best[j], prev[j] = value, i
    j = int(np.argmax(best))
    chain = []
    while j >= 0:
        chain.append(pts[j])
        j = prev[j]
    return chain[::-1]


def _stall_count(ratio: float) -> int:
    return 1 if ratio < WIDE_STALL else round(ratio)


def _cars_in(cars: Sequence[Car], x0: float, x1: float, band: Band) -> list[Car]:
    return [c for c in cars if x0 <= c.cx <= x1 and band.y0 <= c.cy <= band.y1]


def row_stalls(
    dividers: Sequence[tuple[float, float]], pitch: float, band: Band, cars: Sequence[Car]
) -> list[FrameStall]:
    """Stalls between kept dividers (missing ones filled evenly), plus one stall past either
    end of each run per car parked there."""
    stalls: list[FrameStall] = []
    runs: list[list[FrameStall]] = [[]]
    for (xa, sa), (xb, sb) in zip(dividers, dividers[1:], strict=False):
        n = _stall_count((xb - xa) / pitch)
        if n > MAX_BLIND_FILL and len(_cars_in(cars, xa, xb, band)) * CARS_PER_FILL < n:
            runs.append([])
            continue
        step = (xb - xa) / n
        for k in range(n):
            runs[-1].append(
                FrameStall(
                    xa + k * step,
                    xa + (k + 1) * step,
                    band.y0,
                    band.y1,
                    left=sa if k == 0 else 0.0,
                    right=sb if k == n - 1 else 0.0,
                )
            )
    for run in runs:
        if not run:
            continue
        if cars:
            for _ in range(MAX_EXTEND):
                x = run[0].x0
                if not _cars_in(cars, x - pitch * 0.85, x - pitch * 0.15, band):
                    break
                run.insert(0, FrameStall(x - pitch, x, band.y0, band.y1, 0.0, run[0].left))
            for _ in range(MAX_EXTEND):
                x = run[-1].x1
                if not _cars_in(cars, x + pitch * 0.15, x + pitch * 0.85, band):
                    break
                run.append(FrameStall(x, x + pitch, band.y0, band.y1, run[-1].right, 0.0))
        stalls.extend(run)
    return stalls


def car_rows(
    cars: Sequence[Car], pitch: float | None, depth: float | None
) -> list[list[FrameStall]]:
    """Rows of three or more parked cars, evenly spaced, where no paint was found.

    Cars are grouped by their centre across the row; within a group, neighbours must be a
    whole number of pitches apart (at most `MAX_BLIND_FILL`). Each run of such cars becomes a
    row: a stall per car and an empty stall per skipped pitch, centred on the fitted lattice.
    """
    if len(cars) < 3:
        return []
    length = float(np.median([c.b for c in cars]))
    width = float(np.median([c.a for c in cars]))
    by_y = sorted(cars, key=lambda c: c.cy)
    groups: list[list[Car]] = [[by_y[0]]]
    for car in by_y[1:]:
        if car.cy - groups[-1][-1].cy <= 0.3 * length:
            groups[-1].append(car)
        else:
            groups.append([car])
    rows = []
    for group in groups:
        if len(group) < 3:
            continue
        group.sort(key=lambda c: c.cx)
        xs = np.array([c.cx for c in group])
        gaps = np.diff(xs)
        d = pitch
        if d is None:
            usable = gaps[gaps >= 0.8 * width]
            if usable.size == 0:
                continue
            d = float(usable.min())
        runs: list[list[int]] = [[0]]
        for i, g in enumerate(gaps):
            n = round(g / d)
            if 1 <= n <= MAX_BLIND_FILL + 1 and abs(g / d - n) <= 0.2:
                runs[-1].append(i + 1)
            else:
                runs.append([i + 1])
        for run in runs:
            if len(run) < 3:
                continue
            rx = xs[run]
            k = np.round((rx - rx[0]) / d)
            d_fit = d if pitch is not None else float(np.polyfit(k, rx, 1)[0])
            origin = float(np.mean(rx - k * d_fit))
            cy = float(np.median([group[i].cy for i in run]))
            half = (depth if depth else 1.15 * length) / 2
            occupied = {int(v) for v in k}
            row = []
            for j in range(int(k.max()) + 1):
                xc = origin + j * d_fit
                row.append(
                    FrameStall(
                        xc - d_fit / 2,
                        xc + d_fit / 2,
                        cy - half,
                        cy + half,
                        0.0,
                        0.0,
                        car=j in occupied,
                    )
                )
            rows.append(row)
    return rows


def off_photo(frame: Frame, xs: Sequence[float], y: float) -> bool:
    """Whether frame height ``y`` is off the photo at most of the dividers ``xs``: probed just
    past a row's open end, it says the row runs off the photo there."""
    if not xs:
        return False
    pts = np.array([[x, y] for x in xs])
    return float(np.mean(~frame.in_photo(pts))) > 0.5
