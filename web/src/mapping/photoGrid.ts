import { fitSchematic, updateSpace, type Grown } from './schematic/edits'
import { cellLabel, cellRect, cellTaken, labelDigits, rowIndex, rowLetter, type Cell, type Grid } from './schematic/grid'
import { formatLabel, normalizeLabel, parseLabel } from './schematic/labels'
import type { DraftLayout, DraftViewpoint, Outline } from './types'

// Which grid cell a photo outline is in, read off the photo itself: its row from the rows of outlines
// around it, its column from the outlines straight above or below it in the other rows (most rows win).
// Unlike the photo <-> schematic fit (sync.ts), this doesn't care how the schematic is drawn, so a row the
// schematic stretches or numbers from the wrong column can't throw it off. It works whichever way the
// photo faces (numbers running left or right, row A at the top or bottom), as long as rows run across it.

interface Marker {
  spaceId: string
  row: number
  col: number
  x: number
  y: number
  w: number
  h: number
}

/** A cell read off a photo; `at` is the column before rounding (how far between columns it sits). */
export interface PhotoCell extends Cell {
  at: number
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

/** The photo's layout as its outlines describe it, or null when it can't be read with confidence. */
interface Layout {
  byRow: Map<number, Marker[]>
  rowY: Map<number, number> // median photo y of each row
  pitch: number // signed photo x per column: negative when numbers run right to left
  rowStep: number // signed photo y per row: negative when row A is at the bottom
}

function layout(all: Marker[]): Layout | null {
  if (all.length === 0) return null
  const byRow = new Map<number, Marker[]>()
  for (const m of all) byRow.set(m.row, [...(byRow.get(m.row) ?? []), m])
  const rowY = new Map([...byRow].map(([r, ms]) => [r, median(ms.map((m) => m.y))!]))
  // Column pitch from neighbouring numbers within each row, signed, across the whole lot (so a row of
  // one space borrows it).
  const steps: number[] = []
  for (const ms of byRow.values()) {
    const sorted = [...ms].sort((a, b) => a.col - b.col)
    sorted.slice(1).forEach((b, i) => {
      if (b.col !== sorted[i].col) steps.push((b.x - sorted[i].x) / (b.col - sorted[i].col))
    })
  }
  const width = median(all.map((m) => m.w))!
  const pitch = median(steps) ?? width
  // Mixed signs mean the outlines disagree about which way numbers run: don't guess.
  if (steps.filter((s) => Math.sign(s) !== Math.sign(pitch)).length * 3 > steps.length) return null
  if (Math.abs(pitch) < width * 0.5) return null
  const rows = [...rowY.keys()].sort((a, b) => a - b)
  const rowSteps = rows.slice(1).map((r, i) => (rowY.get(r)! - rowY.get(rows[i])!) / (r - rows[i]))
  const height = median(all.map((m) => m.h))!
  const rowStep = median(rowSteps) ?? height
  // Rows must stack one way, each clearly apart: otherwise rows don't run across this photo.
  if (rowSteps.some((s) => Math.sign(s) !== Math.sign(rowStep) || Math.abs(s) < height * 0.5)) return null
  return { byRow, rowY, pitch, rowStep }
}

/** The (unrounded) column at photo x, counted from `row`'s marker nearest x; and how many columns away that is. */
function columnIn(row: Marker[], x: number, pitch: number): { at: number; reach: number } {
  const nearest = row.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a))
  const offset = (x - nearest.x) / pitch
  return { at: nearest.col + offset, reach: Math.abs(offset) }
}

/**
 * The (unrounded) column at photo point (x, y) for a space in `row`. Each other row whose outlines reach
 * to within a column and a half of x says which column is there; most rows' say wins (one row numbered
 * from the wrong column is outvoted), a tie going to the nearest row. With no row that close, the row
 * whose outlines come closest decides; with no other row, its own.
 */
function photoColumn(lay: Layout, row: number, x: number, y: number): number {
  const others = [...lay.byRow].filter(([r]) => r !== row)
  if (others.length === 0) return columnIn(lay.byRow.get(row)!, x, lay.pitch).at
  const votes = others
    .map(([r, ms]) => ({ ...columnIn(ms, x, lay.pitch), distance: Math.abs(lay.rowY.get(r)! - y) }))
    .sort((a, b) => a.distance - b.distance)
  const near = votes.filter((v) => v.reach <= 1.5)
  if (near.length === 0) return votes.reduce((a, b) => (b.reach < a.reach ? b : a)).at
  const counts = new Map<number, number>()
  for (const v of near) counts.set(Math.round(v.at), (counts.get(Math.round(v.at)) ?? 0) + 1)
  const most = Math.max(...counts.values())
  return near.find((v) => counts.get(Math.round(v.at)) === most)!.at
}

/** The row at photo y: the row whose middle is within half a row of it, else counted on from the nearest. */
function photoRow(lay: Layout, y: number): number {
  const [row, rowY] = [...lay.rowY].reduce((a, b) => (Math.abs(b[1] - y) < Math.abs(a[1] - y) ? b : a))
  const off = (y - rowY) / lay.rowStep
  return row + (Math.abs(off) < 0.5 ? 0 : Math.round(off))
}

/**
 * The cell the photo puts `outline` in, or null when the photo's outlines can't say (nothing outlined,
 * or rows that don't run across the photo). `at` is the column before rounding.
 */
export function photoCell(draft: DraftLayout, view: DraftViewpoint, outline: Outline, exceptId?: string): PhotoCell | null {
  const lay = layout(markers(draft, view, exceptId))
  if (!lay) return null
  const me = box(outline)
  const row = photoRow(lay, me.y)
  const at = photoColumn(lay, row, me.x, me.y)
  return { row, col: Math.round(at), at }
}

/**
 * Renumber `row` to match the photo: each of its outlined spaces is named for the column the photo puts
 * it in and moved into that cell on the schematic. Spaces with no outline here keep their label unless a
 * renumbered space now has it; then they take their own cell's label if free. `clashes` counts spaces
 * left sharing a label (two outlines in one column, or nowhere free to go). Retired labels may be reused.
 */
export function matchRowToPhoto(
  draft: DraftLayout,
  view: DraftViewpoint,
  row: number,
  grid: Grid,
): { draft: DraftLayout; clashes: number } {
  const letter = rowLetter(row)
  const lay = layout(markers(draft, view))
  if (!letter || !lay) return { draft, clashes: 0 }
  const digits = labelDigits(draft.spaces)
  const taken = new Set<number>()
  const placed = new Map<string, { label: string; col: number }>()
  let clashes = 0
  for (const m of [...(lay.byRow.get(row) ?? [])].sort((a, b) => (a.x - b.x) * Math.sign(lay.pitch))) {
    const col = Math.round(photoColumn(lay, row, m.x, m.y))
    if (col < 0 || taken.has(col)) {
      clashes++ // keeps its label, which another space may now have
      continue
    }
    taken.add(col)
    placed.set(m.spaceId, { label: formatLabel(letter, col + 1, digits), col })
  }
  const spaces = draft.spaces.map((s) => {
    const p = placed.get(s.spaceId)
    return p ? { ...s, label: p.label, rect: cellRect(grid, { row, col: p.col }) } : s
  })
  // Active spaces left with a label just handed out: name them for their own cell when it's free.
  const used = new Set(spaces.filter((s) => !s.retired).map((s) => normalizeLabel(s.label)))
  const given = new Set([...placed.values()].map((p) => normalizeLabel(p.label)))
  const fixed = spaces.map((s) => {
    if (s.retired || placed.has(s.spaceId) || !given.has(normalizeLabel(s.label))) return s
    const own = cellLabel({ row, col: Math.floor((s.rect.x + s.rect.w / 2 - grid.x0) / grid.cellW) }, digits)
    if (!own || used.has(normalizeLabel(own))) {
      clashes++
      return s
    }
    used.add(normalizeLabel(own))
    return { ...s, label: own }
  })
  return { draft: { ...draft, spaces: fixed }, clashes }
}

/**
 * Match the schematic to the photo for one outlined space: it moves into the cell its outline is in on
 * `viewId`'s photo and takes that cell's label. If another active space already has the label, the row
 * is renumbered from the photo (matchRowToPhoto; `renumbered` is set). If another space is outlined in
 * the same spot on the photo, they're duplicates: nothing changes. A name like "Gate" is kept. `note`
 * says what happened.
 */
export function placeFromPhoto(
  draft: DraftLayout,
  viewId: string,
  spaceId: string,
  grid: Grid,
): Grown & { note?: string; renumbered?: boolean } {
  const unchanged = { draft, dx: 0, dy: 0 }
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  const space = draft.spaces.find((s) => s.spaceId === spaceId)
  const outline = view?.outlines[spaceId]
  if (!view || !space || !outline || space.retired) return unchanged
  const cell = photoCell(draft, view, outline, spaceId)
  if (!cell) return { ...unchanged, note: 'Outline more spaces on this photo first, so it can tell rows and columns' }
  const label = cellLabel(cell, Math.max(2, parseLabel(space.label)?.digits ?? labelDigits(draft.spaces)))
  if (!label) return { ...unchanged, note: 'The photo puts this space before column 1 or above row A; it stays as it is' }
  // Another space outlined in the same spot on the photo is the same physical space: a duplicate.
  const others = markers(draft, view, spaceId)
  const lay = layout(others)
  const twin = lay && others.find((m) => m.row === cell.row && Math.round(photoColumn(lay, m.row, m.x, m.y)) === cell.col)
  if (twin) {
    const name = draft.spaces.find((s) => s.spaceId === twin.spaceId)!.label
    return { ...unchanged, note: `${name} is already outlined in that spot; delete one of the two` }
  }
  const rect = cellRect(grid, cell)
  const custom = !parseLabel(space.label) && space.label.trim() !== ''
  const holder = draft.spaces.find(
    (s) => !s.retired && s.spaceId !== spaceId && normalizeLabel(s.label) === normalizeLabel(label),
  )
  if (custom || !holder) {
    const stacked = cellTaken(grid, draft.spaces, cell, null, spaceId)
    const moved = fitSchematic(updateSpace(draft, spaceId, custom ? { rect } : { label, rect }))
    const note = [custom ? `Moved into ${label}'s cell` : `Now ${label}`]
    if (stacked) note.push('another space is drawn in that cell on the schematic; match it to the photo too')
    return { ...moved, note: note.join('; ') }
  }
  // The row's numbering is off from the photo: renumber it, this space included.
  const { draft: renumbered, clashes } = matchRowToPhoto(updateSpace(draft, spaceId, { label, rect }), view, cell.row, grid)
  const after = renumbered.spaces.find((s) => s.spaceId === spaceId)!
  const note = [`Now ${after.label}; row ${rowLetter(cell.row)} renumbered to match the photo`]
  if (clashes) note.push(`${clashes} label${clashes === 1 ? '' : 's'} still clash${clashes === 1 ? 'es' : ''}; rename by hand`)
  return { ...fitSchematic(renumbered), note: note.join('; '), renumbered: true }
}
