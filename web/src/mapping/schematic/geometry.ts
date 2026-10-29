import type { DraftRect, DraftSpace } from '../types'

/** Schematic size in schematic units (`draft.schematic`). */
export interface Bounds {
  width: number
  height: number
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

/** Snap to whole units, keep at least MIN_SIDE per side, and keep the rectangle inside the schematic. */
export function clampRect(r: DraftRect, b: Bounds): DraftRect {
  const w = clamp(Math.round(r.w), Math.min(MIN_SIDE, b.width), b.width)
  const h = clamp(Math.round(r.h), Math.min(MIN_SIDE, b.height), b.height)
  return { x: clamp(Math.round(r.x), 0, b.width - w), y: clamp(Math.round(r.y), 0, b.height - h), w, h }
}

/** Move by (dx, dy) units; the size is kept and the rectangle stops at the schematic edge. */
export function moveRect(r: DraftRect, dx: number, dy: number, b: Bounds): DraftRect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, b)
}

/** Drag one corner by (dx, dy) units; the opposite corner stays put. */
export function resizeRect(r: DraftRect, corner: Corner, dx: number, dy: number, b: Bounds): DraftRect {
  const start = clampRect(r, b)
  let left = start.x
  let top = start.y
  let right = start.x + start.w
  let bottom = start.y + start.h
  const min = (side: number) => Math.min(MIN_SIDE, side)
  if (corner === 'nw' || corner === 'sw') left = clamp(Math.round(left + dx), 0, right - min(b.width))
  else right = clamp(Math.round(right + dx), left + min(b.width), b.width)
  if (corner === 'nw' || corner === 'ne') top = clamp(Math.round(top + dy), 0, bottom - min(b.height))
  else bottom = clamp(Math.round(bottom + dy), top + min(b.height), b.height)
  return { x: left, y: top, w: right - left, h: bottom - top }
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
