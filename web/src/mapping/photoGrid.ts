import { fitSchematic, leanLikeRows, updateSpace, type Grown } from './schematic/edits'
import { cellLabel, cellRect, cellTaken, insertAtRowStart, insertInRow, labelDigits, rowIndex, rowLetter, type Cell, type Grid } from './schematic/grid'
import { formatLabel, normalizeLabel, parseLabel } from './schematic/labels'
import { cutByBorder } from './photo/geom'
import type { DraftLayout, DraftViewpoint, Outline } from './types'

// Which grid cell a photo outline is in, read off the photo itself: its row from the rows of outlines
// around it, its column from the outlines straight above or below it in the other rows (most rows win).
// Unlike the photo <-> schematic fit (sync.ts), this doesn't care how the schematic is drawn, so a row the
// schematic stretches or numbers from the wrong column can't throw it off. It works whichever way the
// photo faces or is turned (numbers running either way, row A at the top or bottom). Columns are read
// straight across rows, so a strong perspective (columns fanning out) reads less well far from a row.

interface Marker {
  spaceId: string
  row: number
  col: number
  outline: Outline
  x: number
  y: number
  w: number
  h: number
}

/** A cell read off a photo; `at` and `rowAt` are the column and row before rounding. */
export interface PhotoCell extends Cell {
  at: number
  rowAt: number
  /**
   * The column its label should name: `col` plus its row's numbering offset near it (offsetNear). A row
   * that starts one space further left than the others (its 01 is left of column 1) names columns one higher.
   */
  named: number
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

/**
 * An outline in the photo's true proportions: outlines are stored as fractions of its width and of its
 * height, so on a 4:3 photo a turn would skew them unless x is stretched back to the photo's shape.
 */
const inProportion = (view: DraftViewpoint, o: Outline): Outline => {
  const img = view.referenceImage
  const aspect = img && img.width > 0 && img.height > 0 ? img.width / img.height : 1
  return o.map(([x, y]) => [x * aspect, y])
}

/** Outlined active spaces in `view` with row-number labels, except `except` (one id or several), in the photo's proportions. */
function markers(draft: DraftLayout, view: DraftViewpoint, except?: string | Iterable<string>): Marker[] {
  const skip = new Set(typeof except === 'string' ? [except] : (except ?? []))
  return draft.spaces.flatMap((s) => {
    const raw = view.outlines[s.spaceId]
    const p = parseLabel(s.label)
    // A cut-off stall's outline (up to the photo's border) would skew its row's height and place.
    if (s.retired || !raw || !p || skip.has(s.spaceId) || cutByBorder(raw)) return []
    const outline = inProportion(view, raw)
    return [{ spaceId: s.spaceId, row: rowIndex(p.row), col: p.num - 1, outline, ...box(outline) }]
  })
}

/**
 * The photo's layout as its outlines describe it, or null when it can't be read with confidence. It is
 * worked out on the photo turned so its rows run level (`level`), so a photo shot at any angle reads the
 * same; markers here are in those turned coordinates.
 */
interface Layout {
  level: (o: Outline) => Outline
  /** Back from levelled, in-proportion coordinates to the fractions outlines are stored in. */
  unlevel: (o: Outline, view: DraftViewpoint) => Outline
  byRow: Map<number, Marker[]>
  rowY: Map<number, number> // median photo y of each row
  pitch: number // signed photo x per column: negative when numbers run right to left
  rowStep: number // signed photo y per row: negative when row A is at the bottom
  height: number // median outline height, levelled
}

/**
 * The angle the photo's rows run at (radians): from every pair of outlines in the same row, a median of
 * their directions around their average, so a stray outline doesn't count. 0 with no row of two.
 */
function rowAngle(raw: Marker[]): number {
  const byRow = new Map<number, Marker[]>()
  for (const m of raw) byRow.set(m.row, [...(byRow.get(m.row) ?? []), m])
  // Directions are lines, not arrows (a pair can be taken either way round), so work with doubled angles.
  const doubled: number[] = []
  for (const ms of byRow.values()) {
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const [dx, dy] = [ms[j].x - ms[i].x, ms[j].y - ms[i].y]
        if (Math.hypot(dx, dy) > 1e-9) doubled.push(2 * Math.atan2(dy, dx)) // stacked outlines say nothing
      }
    }
  }
  if (doubled.length === 0) return 0
  const mean = Math.atan2(
    doubled.reduce((t, a) => t + Math.sin(a), 0),
    doubled.reduce((t, a) => t + Math.cos(a), 0),
  )
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a)) // into (-pi, pi]
  return (mean + median(doubled.map((a) => wrap(a - mean)))!) / 2
}

function layout(raw: Marker[]): Layout | null {
  if (raw.length === 0) return null
  // Turn the photo so its rows run level, then read it as if it were shot square-on.
  const angle = rowAngle(raw)
  const [c, s] = [Math.cos(angle), Math.sin(angle)]
  const level = (o: Outline): Outline => o.map(([x, y]) => [x * c + y * s, -x * s + y * c])
  const unlevel = (o: Outline, view: DraftViewpoint): Outline => {
    const img = view.referenceImage
    const aspect = img && img.width > 0 && img.height > 0 ? img.width / img.height : 1
    return o.map(([x, y]) => [(x * c - y * s) / aspect, x * s + y * c])
  }
  const all = raw.map((m) => ({ ...m, ...box(level(m.outline)) }))
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
  const rows = [...rowY.keys()].sort((a, b) => a - b)
  const rowSteps = rows.slice(1).map((r, i) => (rowY.get(r)! - rowY.get(rows[i])!) / (r - rows[i]))
  const rowStep = median(rowSteps) ?? median(all.map((m) => m.h))!
  // Columns closer than a quarter of a space (two outlines stacked under far-apart numbers) can't be real.
  if (Math.abs(pitch) < width * 0.25 || rowStep === 0) return null
  // Most neighbouring numbers and rows must agree on which way they run; a few stray ones (a row half
  // outlined, a mislabelled space) are outvoted, which is when renumbering is wanted.
  const against = (values: number[], sign: number) => values.filter((v) => Math.sign(v) !== sign).length * 3 > values.length
  if (against(steps, Math.sign(pitch)) || against(rowSteps, Math.sign(rowStep))) return null
  // Levelled, each row must keep to its own band of height: rows are told apart by height (photoRow).
  // Rows that still overlap (outlines that don't make straight rows) can't be read.
  const spread = median([...byRow.values()].filter((ms) => ms.length > 1).map(band))
  if (byRow.size > 1 && spread !== null && spread > Math.abs(rowStep) / 2) return null
  // Columns are read straight across rows. When many rows still tilt after levelling (a strong
  // perspective: rows converging), a column would drift a third of a column per row: don't read it.
  const tilts = [...byRow.values()].filter((ms) => ms.length > 2).map(slope)
  if (tilts.filter((t) => Math.abs(t * rowStep) > Math.abs(pitch) / 3).length * 3 > tilts.length) return null
  return { level, unlevel, byRow, rowY, pitch, rowStep, height: median(all.map((m) => m.h))! }
}

/** How a row tilts (y per x): the median slope between its outlines, so one stray doesn't count. */
function slope(ms: Marker[]): number {
  const slopes: number[] = []
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      if (ms[j].x !== ms[i].x) slopes.push((ms[j].y - ms[i].y) / (ms[j].x - ms[i].x))
    }
  }
  return median(slopes) ?? 0
}

/**
 * How tall a band a row's outlines fill on the photo: twice their median distance from the row's median
 * height, so one stray outline doesn't count.
 */
function band(ms: Marker[]): number {
  const mid = median(ms.map((m) => m.y))!
  return 2 * median(ms.map((m) => Math.abs(m.y - mid)))!
}

/** The (unrounded) column at photo x, counted from `row`'s marker nearest x; and how many columns away that is. */
function columnIn(lay: Layout, row: Marker[], x: number): { at: number; reach: number } {
  const nearest = row.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a))
  const offset = (x - nearest.x) / lay.pitch
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
  if (others.length === 0) return columnIn(lay, lay.byRow.get(row)!, x).at
  const votes = others
    .map(([r, ms]) => ({ ...columnIn(lay, ms, x), distance: Math.abs(lay.rowY.get(r)! - y) }))
    .sort((a, b) => a.distance - b.distance)
  const near = votes.filter((v) => v.reach <= 1.5)
  if (near.length === 0) return votes.reduce((a, b) => (b.reach < a.reach ? b : a)).at
  const counts = new Map<number, number>()
  for (const v of near) counts.set(Math.round(v.at), (counts.get(Math.round(v.at)) ?? 0) + 1)
  const most = Math.max(...counts.values())
  return near.find((v) => counts.get(Math.round(v.at)) === most)!.at
}

/**
 * The row at photo y, counted from the nearest row's middle (`at` before rounding): within half a row of
 * it, that row; further out (past the outermost row), rows on by the row step.
 */
function photoRow(lay: Layout, x: number, y: number): { row: number; at: number } {
  const [row, rowY] = [...lay.rowY].reduce((a, b) => (Math.abs(b[1] - y) < Math.abs(a[1] - y) ? b : a))
  const off = (y - rowY) / lay.rowStep
  const step = Math.sign(off) * Math.round(Math.abs(off))
  // Past the outermost row by more than half a space is a new row beyond it, even where the rows are
  // not evenly spaced (back-to-back rows between wide aisles make the median row step too big). "Past"
  // is measured from the row's own line at x, so the far end of a tilted row (perspective) still reads
  // as that row.
  const rows = [...lay.rowY.keys()]
  const ms = lay.byRow.get(row) ?? []
  const lineY = ms.length > 1 ? rowY + slope(ms) * (x - median(ms.map((m) => m.x))!) : rowY
  const side = Math.sign(y - lineY) // which way from the nearest row, on the photo
  const beyond =
    Math.abs(y - lineY) > lay.height / 2 &&
    ((row === Math.min(...rows) && side === -Math.sign(lay.rowStep)) ||
      (row === Math.max(...rows) && side === Math.sign(lay.rowStep)))
  return { row: beyond && step === 0 ? row + Math.sign(off) : row + step, at: row + off }
}

/**
 * How a row's numbers sit against the lot's columns near photo x: on its three spaces nearest x, their
 * (number - 1) minus the column the photo puts them in, before rounding (0 for a row numbered like the
 * others, or an empty one). Across the photo, perspective makes the columns read from other rows drift, and nearby
 * spaces drift the same way, so this cancels it where it matters.
 */
function offsetNear(lay: Layout, row: number, x: number): number {
  const near = [...(lay.byRow.get(row) ?? [])].sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x)).slice(0, 3)
  const offsets = near.map((m) => m.col - photoColumn(lay, row, m.x, m.y))
  // Two that disagree: the nearer one decides (an average would round either way).
  if (offsets.length === 2 && Math.round(offsets[0]) !== Math.round(offsets[1])) return offsets[0]
  return median(offsets) ?? 0
}

/** The perspective drift near photo x in `row`: offsetNear less its whole part, so between -0.5 and 0.5. */
function driftNear(lay: Layout, row: number, x: number): number {
  const o = offsetNear(lay, row, x)
  return o - Math.round(o)
}

/**
 * The cell the photo puts `outline` in, or null when the photo's outlines can't say (nothing outlined,
 * or rows that don't run across the photo). `at` is the column before rounding.
 */
export function photoCell(draft: DraftLayout, view: DraftViewpoint, outline: Outline, exceptId?: string): PhotoCell | null {
  const lay = layout(markers(draft, view, exceptId))
  if (!lay) return null
  const me = box(lay.level(inProportion(view, outline)))
  const { row, at: rowAt } = photoRow(lay, me.x, me.y)
  const at = photoColumn(lay, row, me.x, me.y)
  const named = besideNumber(lay, row, me) ?? Math.round(at + offsetNear(lay, row, me.x))
  return { row, col: Math.round(at), at, rowAt, named }
}

/** How far an outline reaches along the unit direction (ux, uy). */
function reach(o: Outline, ux: number, uy: number): number {
  const along = o.map(([x, y]) => x * ux + y * uy)
  return Math.max(...along) - Math.min(...along)
}

/**
 * The place in a row that `outline` sits in on the photo, read from that row's outlines alone: the two
 * outlined neighbours (next to each other among the row's outlines) its middle lies between. `num` is the
 * number it should have: the one its position points at when numbers are free between the two, else the
 * higher neighbour's (which then has to move up). Unlike photoCell this needs no lattice across the
 * rows, so it still reads a photo whose rows converge. Null when it lies between no two: on top of a
 * neighbour, off their line by more than half a stall's depth, with less than half a stall of room
 * between them, or with far more room than the numbers between them account for. Of several pairs, the
 * one whose line it is nearest.
 */
export function photoRowSlot(
  draft: DraftLayout,
  view: DraftViewpoint,
  outline: Outline,
  exceptId?: string,
): { row: number; num: number } | null {
  const me = inProportion(view, outline)
  const mid = box(me)
  const byRow = new Map<number, Marker[]>()
  for (const m of markers(draft, view, exceptId)) byRow.set(m.row, [...(byRow.get(m.row) ?? []), m])
  let best: { row: number; num: number; off: number } | null = null
  for (const [row, ms] of byRow) {
    const sorted = [...ms].sort((a, b) => a.col - b.col)
    for (let i = 1; i < sorted.length; i++) {
      const [a, b] = [sorted[i - 1], sorted[i]]
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      if (b.col === a.col || length < 1e-9) continue
      const [ux, uy] = [(b.x - a.x) / length, (b.y - a.y) / length]
      const along = (mid.x - a.x) * ux + (mid.y - a.y) * uy
      const off = Math.abs((mid.x - a.x) * uy - (mid.y - a.y) * ux)
      const [wa, wb] = [reach(a.outline, ux, uy), reach(b.outline, ux, uy)]
      const depth = (reach(a.outline, -uy, ux) + reach(b.outline, -uy, ux)) / 2
      // Between the two and clear of both, on their line.
      if (along <= wa / 2 || length - along <= wb / 2 || off > depth / 2) continue
      const free = b.col - a.col - 1 // numbers between the two
      // Room between them for at least half of it, and no more than the stalls that could be missing
      // there (a space labeled for the wrong end of the row is no neighbour).
      const wm = reach(me, ux, uy)
      const room = length - (wa + wb) / 2
      if (room < wm / 2 || room > 2 * (free + 1) * Math.max(wa, wb, wm)) continue
      if (best && best.off <= off) continue
      const step = free > 0 ? Math.min(free, Math.max(1, Math.round((along / length) * (free + 1)))) : 1
      best = { row, num: a.col + 1 + step, off }
    }
  }
  return best && { row: best.row, num: best.num }
}

/**
 * Put `spaceId` in the place of a row its outline sits in on `viewId`'s photo (photoRowSlot): it takes
 * that number and cell and leans like the row, and spaces in the way move up one (insertInRow). `moved`
 * lists the spaces whose cell changed: none when it is already there, or (with a `note`) when the row
 * can't make room. Null when the photo shows no such place, or the space has a name like "Gate". The
 * map is not grown here (fitSchematic is the caller's).
 */
export function placeInPhotoRow(
  draft: DraftLayout,
  viewId: string,
  spaceId: string,
  grid: Grid,
): { draft: DraftLayout; moved: string[]; note?: string } | null {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  const space = draft.spaces.find((s) => s.spaceId === spaceId)
  const outline = view?.outlines[spaceId]
  if (!view || !space || !outline || space.retired) return null
  if (!parseLabel(space.label) && space.label.trim() !== '') return null
  const slot = photoRowSlot(draft, view, outline, spaceId)
  if (!slot) return null
  const letter = rowLetter(slot.row)
  const target = { row: slot.row, col: slot.num - 1 }
  const placed = insertInRow(draft, grid, spaceId, target.row, target.col)
  if (!placed) {
    return { draft, moved: [], note: `Row ${letter} can't make room for ${space.label.trim() || 'this space'}: a space that isn't numbered in the row sits in the way` }
  }
  const now = placed.draft.spaces.find((s) => s.spaceId === spaceId)!
  const rect = cellRect(grid, target)
  const stayed = normalizeLabel(now.label) === normalizeLabel(space.label) && rect.x === space.rect.x && rect.y === space.rect.y && rect.w === space.rect.w && rect.h === space.rect.h
  if (stayed && placed.shifted.length === 0) return { draft, moved: [] }
  const n = placed.shifted.length
  const note = n === 0 ? `Now ${now.label}` : `Now ${now.label}; ${n === 1 ? 'the space' : `the ${n} spaces`} after it in row ${letter} moved up one to make room`
  return { draft: leanLikeRows(placed.draft, [spaceId]), moved: [spaceId, ...placed.shifted], note }
}

/** Outlines this close along the row (a share of the narrower one's width) are side by side. */
const BESIDE = 0.35

/**
 * The number right after (or before) the space of `row` the outline sits beside on the photo, or null
 * when it touches none. Side by side means no stall between them, whatever the lattice says: a wide
 * stall (a van bay) or the photo's perspective can put the lattice's count a column off.
 */
function besideNumber(lay: Layout, row: number, me: { x: number; y: number; w: number; h: number }): number | null {
  const near = (lay.byRow.get(row) ?? [])
    .filter((m) => Math.abs(m.y - me.y) <= 0.5 * Math.max(m.h, me.h))
    .map((m) => ({ m, gap: Math.abs(me.x - m.x) - (me.w + m.w) / 2 }))
    .filter(({ m, gap }) => gap <= BESIDE * Math.min(me.w, m.w))
    .sort((a, b) => a.gap - b.gap)[0]
  if (!near) return null
  // Numbers run the way the lattice's pitch does.
  return near.m.col + Math.sign(me.x - near.m.x) * Math.sign(lay.pitch)
}

/**
 * An outline for the space numbered `named` + 1 in `row`, shaped like its neighbours: the nearest
 * outlined space of that row (by number) copied along the row by the columns between them. With nothing
 * in the row, the nearest other row's nearest space, carried across the rows too. Null with nothing to
 * copy, or when the copy would sit off the photo.
 */
export function outlineLike(
  draft: DraftLayout,
  view: DraftViewpoint,
  row: number,
  named: number,
  except?: string | Iterable<string>,
): Outline | null {
  const lay = layout(markers(draft, view, except))
  if (!lay) return null
  // Copy an accepted outline over a proposal still waiting for review, when the row has one.
  const pending = (m: Marker) => view.outlineReview?.[m.spaceId]?.status === 'pending'
  const settled = (ms: Marker[]) => (ms.some((m) => !pending(m)) ? ms.filter((m) => !pending(m)) : ms)
  const near = (ms: Marker[]) => settled(ms).reduce((a, b) => (Math.abs(b.col - named) < Math.abs(a.col - named) ? b : a))
  const own = lay.byRow.get(row)
  let from: Marker
  let rows = 0
  if (own?.length) {
    from = near(own)
  } else {
    const [r, ms] = [...lay.byRow].reduce((a, b) => (Math.abs(b[0] - row) < Math.abs(a[0] - row) ? b : a))
    from = near(ms)
    rows = row - r
  }
  const dx = (named - from.col) * lay.pitch
  const dy = rows * lay.rowStep
  const moved = lay.unlevel(
    lay.level(from.outline).map(([x, y]) => [x + dx, y + dy]),
    view,
  )
  const mid = box(moved)
  if (mid.x < 0 || mid.x > 1 || mid.y < 0 || mid.y > 1) return null
  return moved.map(([x, y]) => [Number(Math.min(1, Math.max(0, x)).toFixed(4)), Number(Math.min(1, Math.max(0, y)).toFixed(4))])
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
  offset: number,
): { draft: DraftLayout; clashes: number } {
  const letter = rowLetter(row)
  const lay = layout(markers(draft, view))
  if (!letter || !lay) return { draft, clashes: 0 }
  const digits = labelDigits(draft.spaces)
  const taken = new Set<number>()
  const placed = new Map<string, { label: string; col: number }>()
  let clashes = 0
  for (const m of [...(lay.byRow.get(row) ?? [])].sort((a, b) => (a.x - b.x) * Math.sign(lay.pitch))) {
    // Each space read with the perspective drift around it cancelled, as photoCell reads a new one.
    const col = Math.round(photoColumn(lay, row, m.x, m.y) + driftNear(lay, row, m.x)) + offset
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
  if (!cell) {
    // A photo whose rows and columns can't be read may still show the two neighbours it sits between.
    const inRow = placeInPhotoRow(draft, viewId, spaceId, grid)
    if (!inRow) return { ...unchanged, note: 'Outline more spaces on this photo first, so it can tell rows and columns' }
    if (inRow.moved.length === 0) return { ...unchanged, note: inRow.note ?? `${space.label} is already where the photo puts it` }
    return { ...fitSchematic(inRow.draft), note: inRow.note, renumbered: inRow.moved.length > 1 }
  }
  const letter = rowLetter(cell.row)
  if (!letter) return { ...unchanged, note: 'The photo puts this space above row A; it stays as it is' }
  const digits = Math.max(2, parseLabel(space.label)?.digits ?? labelDigits(draft.spaces))
  // Another space outlined in the same spot on the photo is the same physical space: a duplicate.
  const lay = layout(markers(draft, view, spaceId))
  const twin = lay?.byRow.get(cell.row)?.find((m) => Math.round(photoColumn(lay, m.row, m.x, m.y)) === cell.col)
  if (twin) {
    const name = draft.spaces.find((s) => s.spaceId === twin.spaceId)!.label
    return { ...unchanged, note: `${name} is already outlined in that spot; delete one of the two` }
  }
  const custom = !parseLabel(space.label) && space.label.trim() !== ''
  const offset = cell.named - cell.col
  if (cell.named < 0 && !custom) {
    // Before the row's first number: it becomes 01, and every other space in the row moves up one
    // number and one cell on the schematic to make room.
    const next = insertAtRowStart(draft, grid, spaceId, cell.row)
    if (!next) return { ...unchanged, note: `Row ${letter} can't move up to make room: a space that isn't numbered sits in the way` }
    const first = formatLabel(letter, 1, digits)
    return { ...fitSchematic(next), note: `Now ${first}; the rest of row ${letter} moved up one to make room`, renumbered: true }
  }
  const target = { row: cell.row, col: Math.max(0, cell.named) }
  const label = cellLabel(target, digits)!
  const rect = cellRect(grid, target)
  const holder = draft.spaces.find(
    (s) => !s.retired && s.spaceId !== spaceId && normalizeLabel(s.label) === normalizeLabel(label),
  )
  if (custom || !holder) {
    const stacked = cellTaken(grid, draft.spaces, target, null, spaceId)
    const moved = fitSchematic(updateSpace(draft, spaceId, custom ? { rect } : { label, rect }))
    const note = [custom ? `Moved into ${label}'s cell` : `Now ${label}`]
    if (stacked) note.push('another space is drawn in that cell on the schematic; match it to the photo too')
    return { ...moved, note: note.join('; ') }
  }
  // The row's numbering is off from the photo: renumber it, this space included.
  const { draft: renumbered, clashes } = matchRowToPhoto(updateSpace(draft, spaceId, { label, rect }), view, cell.row, grid, offset)
  const after = renumbered.spaces.find((s) => s.spaceId === spaceId)!
  const note = [`Now ${after.label}; row ${rowLetter(cell.row)} renumbered to match the photo`]
  if (clashes) note.push(`${clashes} label${clashes === 1 ? '' : 's'} still clash${clashes === 1 ? 'es' : ''}; rename by hand`)
  return { ...fitSchematic(renumbered), note: note.join('; '), renumbered: true }
}
