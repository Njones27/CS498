import { fitSchematic, updateSpace, type Grown } from './schematic/edits'
import { cellLabel, cellRect, labelDigits, rowIndex, rowLetter, type Cell, type Grid } from './schematic/grid'
import { formatLabel, normalizeLabel, parseLabel } from './schematic/labels'
import type { DraftLayout, DraftViewpoint, Outline } from './types'

// Which grid cell a photo outline is in, read off the photo itself: its row from the outlines beside it,
// its column from the outlines straight above or below it in the other rows (most rows win). Unlike the
// photo <-> schematic fit (sync.ts), this doesn't care how the schematic is drawn, so a row the schematic
// stretches or numbers from the wrong column can't throw it off.

interface Marker {
  spaceId: string
  row: number
  col: number
  x: number
  y: number
  w: number
  h: number
}

/** Middle and size of an outline on the photo (fractions). */
function box(outline: Outline) {
  const xs = outline.map((p) => p[0])
  const ys = outline.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** Outlined active spaces in `view` with row-number labels, except `exceptId`. */
function markers(draft: DraftLayout, view: DraftViewpoint, exceptId?: string): Marker[] {
  return draft.spaces.flatMap((s) => {
    const outline = view.outlines[s.spaceId]
    const p = parseLabel(s.label)
    if (s.retired || !outline || !p || s.spaceId === exceptId) return []
    return [{ spaceId: s.spaceId, row: rowIndex(p.row), col: p.num - 1, ...box(outline) }]
  })
}

/** The column at photo x in a row of markers: from the nearest marker, counting space widths to either side. */
function columnIn(row: Marker[], x: number): number {
  const sorted = [...row].sort((a, b) => a.x - b.x)
  const steps = sorted.slice(1).flatMap((b, i) => (b.col !== sorted[i].col ? [Math.abs((b.x - sorted[i].x) / (b.col - sorted[i].col))] : []))
  const nearest = sorted.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a))
  const pitch = median(steps) ?? nearest.w
  return nearest.col + Math.round((x - nearest.x) / pitch)
}

/**
 * The cell the photo puts `outline` in, or null with nothing outlined to go by. Row: the row of the
 * outlines level with it (or one past the nearest row, for a new row). Column: what most other rows'
 * outlines straight above or below it say (photoColumn); with no other row, from its own row.
 */
export function photoCell(draft: DraftLayout, view: DraftViewpoint, outline: Outline, exceptId?: string): Cell | null {
  const all = markers(draft, view, exceptId)
  if (all.length === 0) return null
  const me = box(outline)
  const level = all.filter((m) => Math.abs(m.y - me.y) < m.h / 2)
  let row: number
  if (level.length) {
    const counts = new Map<number, number>()
    for (const m of level) counts.set(m.row, (counts.get(m.row) ?? 0) + 1)
    row = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  } else {
    const nearest = all.reduce((a, b) => (Math.abs(b.y - me.y) < Math.abs(a.y - me.y) ? b : a))
    row = nearest.row + (me.y > nearest.y ? 1 : -1)
  }
  return { row, col: photoColumn(all, row, me.x, me.y) }
}

/**
 * The column at photo point (x, y) for a space in `row`. Every other row says which of its columns is at
 * x, and most rows' say wins: one row numbered from the wrong column (as the drone lot's row B is) is
 * outvoted. A tie goes to the nearest row; with no other row, its own row decides.
 */
function photoColumn(all: Marker[], row: number, x: number, y: number): number {
  const byRow = new Map<number, Marker[]>()
  for (const m of all) byRow.set(m.row, [...(byRow.get(m.row) ?? []), m])
  const others = [...byRow].filter(([r]) => r !== row)
  if (others.length === 0) return columnIn(byRow.get(row)!, x)
  const rowY = (ms: Marker[]) => median(ms.map((m) => m.y))!
  const votes = others
    .map(([, ms]) => ({ col: columnIn(ms, x), distance: Math.abs(rowY(ms) - y) }))
    .sort((a, b) => a.distance - b.distance)
  const counts = new Map<number, number>()
  for (const v of votes) counts.set(v.col, (counts.get(v.col) ?? 0) + 1)
  const most = Math.max(...counts.values())
  return votes.find((v) => counts.get(v.col) === most)!.col
}

/**
 * Renumber `row` to match the photo: each of its outlined spaces is named for the column the photo puts
 * it in (counted from the nearest other row) and moved into that cell on the schematic. Spaces in the
 * row with no outline here keep their label unless a renumbered space now has it; then they take their
 * own cell's label if free. Two outlines in one column: the second keeps its label (the duplicate shows).
 */
export function matchRowToPhoto(draft: DraftLayout, view: DraftViewpoint, row: number, grid: Grid): DraftLayout {
  const letter = rowLetter(row)
  if (!letter) return draft
  const all = markers(draft, view)
  const inRow = all.filter((m) => m.row === row)
  const digits = labelDigits(draft.spaces)
  const taken = new Set<number>()
  const placed = new Map<string, { label: string; col: number }>()
  for (const m of [...inRow].sort((a, b) => a.x - b.x)) {
    const col = photoColumn(all, row, m.x, m.y)
    if (col < 0 || taken.has(col)) continue
    taken.add(col)
    placed.set(m.spaceId, { label: formatLabel(letter, col + 1, digits), col })
  }
  const given = new Set([...placed.values()].map((p) => normalizeLabel(p.label)))
  const spaces = draft.spaces.map((s) => {
    const p = placed.get(s.spaceId)
    if (p) return { ...s, label: p.label, rect: cellRect(grid, { row, col: p.col }) }
    return s
  })
  // A space in the row with no outline here whose label was just given out: name it for its own cell.
  const used = new Set(spaces.filter((s) => !s.retired).map((s) => normalizeLabel(s.label)))
  const fixed = spaces.map((s) => {
    if (s.retired || placed.has(s.spaceId) || parseLabel(s.label)?.row !== letter || !given.has(normalizeLabel(s.label))) return s
    const c = { row, col: Math.floor((s.rect.x + s.rect.w / 2 - grid.x0) / grid.cellW) }
    const own = cellLabel(c, digits)
    if (!own || used.has(normalizeLabel(own))) return s
    used.add(normalizeLabel(own))
    return { ...s, label: own }
  })
  return { ...draft, spaces: fixed }
}

/**
 * Match the schematic to the photo for one outlined space: it moves into the cell its outline is in on
 * `viewId`'s photo and takes that cell's label. If another space in that row already has the label, the
 * whole row is renumbered from the photo (matchRowToPhoto). If another space is outlined in the same
 * spot on the photo, they're duplicates: nothing changes and `note` says so. Names like "Gate" are kept.
 */
export function placeFromPhoto(
  draft: DraftLayout,
  viewId: string,
  spaceId: string,
  grid: Grid,
): Grown & { note?: string } {
  const unchanged = { draft, dx: 0, dy: 0 }
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  const space = draft.spaces.find((s) => s.spaceId === spaceId)
  const outline = view?.outlines[spaceId]
  if (!view || !space || !outline || space.retired) return unchanged
  const cell = photoCell(draft, view, outline, spaceId)
  if (!cell) return { ...unchanged, note: 'Outline a few spaces on this photo first, so it can tell rows and columns' }
  const custom = !parseLabel(space.label) && space.label.trim() !== ''
  const label = cellLabel(cell, Math.max(2, parseLabel(space.label)?.digits ?? labelDigits(draft.spaces)))
  if (!label) return { ...unchanged, note: 'The photo puts this space before column 1 or above row A; it stays as it is' }
  // Another space outlined in the same spot on the photo is the same physical space: a duplicate.
  const others = markers(draft, view, spaceId)
  const twin = others.find((m) => m.row === cell.row && photoColumn(others, m.row, m.x, m.y) === cell.col)
  if (twin) {
    const name = draft.spaces.find((s) => s.spaceId === twin.spaceId)!.label
    return { ...unchanged, note: `${name} is already outlined in that spot; delete one of the two` }
  }
  const rect = cellRect(grid, cell)
  const holder = draft.spaces.find(
    (s) => !s.retired && s.spaceId !== spaceId && normalizeLabel(s.label) === normalizeLabel(label),
  )
  if (custom) return { ...fitSchematic(updateSpace(draft, spaceId, { rect })), note: `Moved into ${label}'s cell` }
  if (!holder) return { ...fitSchematic(updateSpace(draft, spaceId, { label, rect })), note: `Now ${label}` }
  // The row's numbering is off from the photo: renumber it, this space included.
  const renumbered = matchRowToPhoto(updateSpace(draft, spaceId, { label, rect }), view, cell.row, grid)
  const after = renumbered.spaces.find((s) => s.spaceId === spaceId)!
  return { ...fitSchematic(renumbered), note: `Now ${after.label}; row ${rowLetter(cell.row)} renumbered to match the photo` }
}
