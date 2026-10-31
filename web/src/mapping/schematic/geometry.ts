import type { DraftRect, DraftSpace } from '../types'

/** An area in schematic units: the map area (`draft.schematic`, origin 0,0) or, while dragging, the visible area. */
export interface Bounds {
  width: number
  height: number
  x?: number // left edge, 0 when left out
  y?: number // top edge, 0 when left out
}

export interface Size {
  w: number
  h: number
}

/** A resize handle, named by compass corner. */
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
export const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

/** Smallest rectangle side, in schematic units. */
export const MIN_SIDE = 10
/** Space between neighbouring rectangles placed by + Space and + Row. */
export const GAP = 10
/** Distance from the schematic edge where a new line of spaces starts. */
export const MARGIN = 20
/** Size of a new space when the draft has nothing to copy it from. */
export const DEFAULT_SIZE: Size = { w: 110, h: 180 }

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export function sameRect(a: DraftRect, b: DraftRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/** Snap to whole units, keep at least MIN_SIDE per side, and keep the rectangle inside the bounds. */
export function clampRect(r: DraftRect, b: Bounds): DraftRect {
  const bx = b.x ?? 0
  const by = b.y ?? 0
  const w = clamp(Math.round(r.w), Math.min(MIN_SIDE, b.width), b.width)
  const h = clamp(Math.round(r.h), Math.min(MIN_SIDE, b.height), b.height)
  return { x: clamp(Math.round(r.x), bx, bx + b.width - w), y: clamp(Math.round(r.y), by, by + b.height - h), w, h }
}

/** Move by (dx, dy) units; the size is kept and the rectangle stops at the schematic edge. */
export function moveRect(r: DraftRect, dx: number, dy: number, b: Bounds): DraftRect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, b)
}

/** Drag one corner by (dx, dy) units; the opposite corner stays put. */
export function resizeRect(r: DraftRect, corner: Corner, dx: number, dy: number, b: Bounds): DraftRect {
  const start = clampRect(r, b)
  const bx = b.x ?? 0
  const by = b.y ?? 0
  let left = start.x
  let top = start.y
  let right = start.x + start.w
  let bottom = start.y + start.h
  const min = (side: number) => Math.min(MIN_SIDE, side)
  if (corner === 'nw' || corner === 'sw') left = clamp(Math.round(left + dx), bx, right - min(b.width))
  else right = clamp(Math.round(right + dx), left + min(b.width), bx + b.width)
  if (corner === 'nw' || corner === 'ne') top = clamp(Math.round(top + dy), by, bottom - min(b.height))
  else bottom = clamp(Math.round(bottom + dy), top + min(b.height), by + b.height)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * Push `r` out of the active spaces it overlaps, each time along the shorter way out (keeping GAP), so an
 * approximate rect (one mapped from a photo) doesn't sit on its neighbours. A few passes settle a row.
 */
export function clearOf(r: DraftRect, spaces: DraftSpace[]): DraftRect {
  let out = r
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    for (const s of spaces) {
      const o = s.rect
      if (s.retired || !(out.x < o.x + o.w && o.x < out.x + out.w && out.y < o.y + o.h && o.y < out.y + out.h)) continue
      const right = o.x + o.w + GAP - out.x
      const left = out.x + out.w + GAP - o.x
      const down = o.y + o.h + GAP - out.y
      const up = out.y + out.h + GAP - o.y
      const step = Math.min(right, left, down, up)
      out =
        step === right ? { ...out, x: out.x + right }
        : step === left ? { ...out, x: out.x - left }
        : step === down ? { ...out, y: out.y + down }
        : { ...out, y: out.y - up }
      moved = true
    }
    if (!moved) break
  }
  return out
}

/** The smallest area holding both. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x ?? 0, b.x ?? 0)
  const y = Math.min(a.y ?? 0, b.y ?? 0)
  const right = Math.max((a.x ?? 0) + a.width, (b.x ?? 0) + b.width)
  const bottom = Math.max((a.y ?? 0) + a.height, (b.y ?? 0) + b.height)
  return { x, y, width: right - x, height: bottom - y }
}

/** The map area plus room for one more `size` space right of it and below it; fitSchematic grows the map to match. */
export function roomFor(b: Bounds, size: Size): Bounds {
  return { width: b.width + size.w + GAP + MARGIN, height: b.height + size.h + GAP + MARGIN }
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** Median width and height (each rounded to whole units), or null for no rectangles. */
export function medianSize(rects: DraftRect[]): Size | null {
  if (rects.length === 0) return null
  return { w: Math.round(median(rects.map((r) => r.w))), h: Math.round(median(rects.map((r) => r.h))) }
}

/** Where a new line of spaces starts: just below the lowest rectangle, or at the top margin. */
export function yBelowAll(spaces: DraftSpace[]): number {
  if (spaces.length === 0) return MARGIN
  return Math.max(...spaces.map((s) => s.rect.y + s.rect.h)) + GAP
}

/** True when the rectangles overlap or come closer than GAP. */
function crowds(a: DraftRect, b: DraftRect): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP
}

/** The first spot, scanning rows top to bottom in GAP steps, where `size` crowds no space; null when full. */
export function findFreeSpot(all: DraftSpace[], size: Size, b: Bounds): DraftRect | null {
  for (let y = 0; y + size.h <= b.height; y += GAP) {
    for (let x = 0; x + size.w <= b.width; x += GAP) {
      const r = { x, y, ...size }
      if (!all.some((s) => crowds(r, s.rect))) return r
    }
  }
  return null
}

/**
 * Rectangle for + Space: right of the rightmost space in its row, else at the start of a new line
 * below everything, else the first free spot. Only a full schematic makes it overlap a space.
 */
export function placeNewSpace(all: DraftSpace[], row: DraftSpace[], size: Size, b: Bounds): DraftRect {
  const fit = clampRect({ x: 0, y: 0, ...size }, b)
  if (row.length > 0) {
    const last = row.reduce((a, s) => (s.rect.x + s.rect.w > a.rect.x + a.rect.w ? s : a))
    const x = last.rect.x + last.rect.w + GAP
    if (x + fit.w <= b.width && last.rect.y + fit.h <= b.height) return clampRect({ ...fit, x, y: last.rect.y }, b)
  }
  const y = yBelowAll(all)
  if (y + fit.h <= b.height) return clampRect({ ...fit, x: MARGIN, y }, b)
  return findFreeSpot(all, fit, b) ?? clampRect({ ...fit, x: MARGIN, y }, b)
}

/** Most spaces + Row can place on one line of this schematic. */
export function maxRowCount(b: Bounds): number {
  return Math.max(1, Math.floor((b.width - 2 * MARGIN + GAP) / (MIN_SIDE + GAP)))
}

/**
 * `count` evenly spaced rectangles on one line at `y`, starting at the left margin. When the line
 * would be wider than the schematic, the rectangles get narrower; the spacing stays even.
 */
export function rowRects(count: number, size: Size, y: number, b: Bounds): DraftRect[] {
  const available = b.width - 2 * MARGIN
  let w = Math.round(size.w)
  let pitch = w + GAP
  if (count * w + (count - 1) * GAP > available) {
    pitch = Math.floor((available + GAP) / count)
    w = Math.max(MIN_SIDE, pitch - GAP)
  }
  const h = clamp(Math.round(size.h), Math.min(MIN_SIDE, b.height), b.height)
  const top = clamp(Math.round(y), 0, b.height - h)
  // The clamp only bites on a schematic too small for the margins; spacing is even otherwise.
  return Array.from({ length: count }, (_, i) => clampRect({ x: MARGIN + i * pitch, y: top, w, h }, b))
}
