import type { DraftLayout, DraftRect, DraftSpace, Point } from '../types'
import { DEFAULT_SIZE, GAP, MARGIN, MIN_SIDE, medianSize, type Corner } from './geometry'
import { formatLabel, normalizeLabel, parseLabel } from './labels'

// The schematic grid: rows are lettered (row 0 is A, then B ... Z, AA ...) and columns numbered from 1,
// so the cell a space sits in is its label: row C, column 7 is C-07. Each cell holds one space-sized box
// with half the gap on each side. Pure; the mapping page keeps the grid it uses (useSchematicGrid).

export interface Grid {
  x0: number // left edge of column 0's cells
  y0: number // top edge of row 0's (row A's) cells
  cellW: number // column pitch: box width plus the gap across
  cellH: number // row pitch: box height plus the gap down
  boxW: number
  boxH: number
}

/** A grid cell: row 0 is row A, column 0 is number 1. Either may be negative (above A, left of 1). */
export interface Cell {
  row: number
  col: number
}

/** The four sizes an admin can set; the origin is always fitted to the spaces' labels. */
export interface GridSizes {
  boxW: number
  boxH: number
  gapX: number
  gapY: number
}

const r2 = (v: number) => Math.round(v * 100) / 100

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA"; null above row A. */
export function rowLetter(row: number): string | null {
  if (!Number.isInteger(row) || row < 0) return null
  let n = row + 1
  let s = ''
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** "A" -> 0, "Z" -> 25, "AA" -> 26. */
export function rowIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export const gridSizes = (g: Grid): GridSizes => ({
  boxW: g.boxW,
  boxH: g.boxH,
  gapX: r2(g.cellW - g.boxW),
  gapY: r2(g.cellH - g.boxH),
})

/**
 * The grid the spaces' labels describe: a space labeled C-07 sits in row C, column 7. Pitches and the
 * origin are medians (column pitch from neighbouring numbers within a row, row pitch from neighbouring
 * rows), so a few misplaced spaces don't skew it. `sizes` replaces any of the fitted sizes.
 */
export function fitGrid(spaces: DraftSpace[], sizes: Partial<GridSizes> = {}): Grid {
  const labeled = spaces.flatMap((s) => {
    const p = s.retired ? null : parseLabel(s.label)
    return p ? [{ rect: s.rect, row: rowIndex(p.row), col: p.num - 1 }] : []
  })
  const size =
    medianSize(labeled.map((l) => l.rect)) ?? medianSize(spaces.filter((s) => !s.retired).map((s) => s.rect)) ?? DEFAULT_SIZE

  const byRow = new Map<number, typeof labeled>()
  for (const l of labeled) byRow.set(l.row, [...(byRow.get(l.row) ?? []), l])
  const colSteps: number[] = []
  const rowY = new Map<number, number>()
  for (const [row, items] of byRow) {
    const sorted = [...items].sort((a, b) => a.col - b.col)
    sorted.slice(1).forEach((b, i) => {
      const a = sorted[i]
      if (b.col > a.col) colSteps.push((b.rect.x - a.rect.x) / (b.col - a.col))
    })
    rowY.set(row, median(items.map((l) => l.rect.y))!)
  }
  const rows = [...rowY.keys()].sort((a, b) => a - b)
  const rowSteps = rows.slice(1).map((r, i) => (rowY.get(r)! - rowY.get(rows[i])!) / (r - rows[i]))

  // A pitch smaller than a box (numbers running right to left, or stacked spaces) can't be a grid.
  const pitchW = median(colSteps)
  const pitchH = median(rowSteps)
  const boxW = r2(sizes.boxW ?? size.w)
  const boxH = r2(sizes.boxH ?? size.h)
  const gapX = r2(sizes.gapX ?? (pitchW != null && pitchW >= size.w ? pitchW - size.w : GAP))
  const gapY = r2(sizes.gapY ?? (pitchH != null && pitchH >= size.h ? pitchH - size.h : GAP))
  const cellW = Math.max(MIN_SIDE, boxW + gapX)
  const cellH = Math.max(MIN_SIDE, boxH + gapY)

  const left = median(labeled.map((l) => l.rect.x - l.col * cellW)) ?? MARGIN
  const top = median(labeled.map((l) => l.rect.y - l.row * cellH)) ?? MARGIN
  return { x0: r2(left - gapX / 2), y0: r2(top - gapY / 2), cellW, cellH, boxW, boxH }
}

export function cellAt(g: Grid, [x, y]: Point): Cell {
  return { row: Math.floor((y - g.y0) / g.cellH), col: Math.floor((x - g.x0) / g.cellW) }
}

/** The box a space fills in `cell`. */
export function cellRect(g: Grid, { row, col }: Cell): DraftRect {
  return {
    x: r2(g.x0 + col * g.cellW + (g.cellW - g.boxW) / 2),
    y: r2(g.y0 + row * g.cellH + (g.cellH - g.boxH) / 2),
    w: g.boxW,
    h: g.boxH,
  }
}

/** How many digits the lot's labels use (A-07 or A-007): the most common width, at least 2. */
export function labelDigits(spaces: DraftSpace[]): number {
  const counts = new Map<number, number>()
  for (const s of spaces) {
    const d = s.retired ? null : parseLabel(s.label)?.digits
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  const [digits] = [...counts].reduce((best, e) => (e[1] > best[1] ? e : best), [2, 0])
  return Math.max(2, digits)
}

/** "C-07" for row 2, column 6; null for a cell above row A or left of column 1. */
export function cellLabel({ row, col }: Cell, digits = 2): string | null {
  const letter = rowLetter(row)
  return letter && col >= 0 ? formatLabel(letter, col + 1, digits) : null
}

const center = (r: DraftRect): Point => [r.x + r.w / 2, r.y + r.h / 2]

/** A moved space drops into the cell under its middle and takes the cell's box. */
export function snapMove(g: Grid, rect: DraftRect): { rect: DraftRect; cell: Cell } {
  const cell = cellAt(g, center(rect))
  return { rect: cellRect(g, cell), cell }
}

/** Nearest value to `v` on the lattice offset + k * step. */
const onLattice = (v: number, offset: number, step: number) => offset + Math.round((v - offset) / step) * step

/** A resized space's dragged edges land on box edges, so it covers whole cells; the other edges stay. */
export function snapResize(g: Grid, rect: DraftRect, corner: Corner): DraftRect {
  const leftOf = g.x0 + (g.cellW - g.boxW) / 2
  const topOf = g.y0 + (g.cellH - g.boxH) / 2
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.w
  let bottom = rect.y + rect.h
  if (corner.endsWith('w')) left = Math.min(onLattice(left, leftOf, g.cellW), right - MIN_SIDE)
  else right = Math.max(onLattice(right, leftOf + g.boxW, g.cellW), left + MIN_SIDE)
  if (corner.startsWith('n')) top = Math.min(onLattice(top, topOf, g.cellH), bottom - MIN_SIDE)
  else bottom = Math.max(onLattice(bottom, topOf + g.boxH, g.cellH), top + MIN_SIDE)
  return { x: r2(left), y: r2(top), w: r2(right - left), h: r2(bottom - top) }
}

/** Most cells one drawn box may fill. */
export const MAX_DRAWN_CELLS = 200

/** The cells a box drawn from `a` to `b` covers, row by row; empty past MAX_DRAWN_CELLS. */
export function cellsIn(g: Grid, a: Point, b: Point): Cell[] {
  const from = cellAt(g, [Math.min(a[0], b[0]), Math.min(a[1], b[1])])
  const to = cellAt(g, [Math.max(a[0], b[0]), Math.max(a[1], b[1])])
  if ((to.row - from.row + 1) * (to.col - from.col + 1) > MAX_DRAWN_CELLS) return []
  const cells: Cell[] = []
  for (let row = from.row; row <= to.row; row++) for (let col = from.col; col <= to.col; col++) cells.push({ row, col })
  return cells
}

/** Whether an active space other than `exceptId` uses `label` or sits (by its middle) in `cell`. */
export function cellTaken(g: Grid, spaces: DraftSpace[], cell: Cell, label: string | null, exceptId?: string): boolean {
  const key = label && normalizeLabel(label)
  return spaces.some((s) => {
    if (s.retired || s.spaceId === exceptId) return false
    if (key && normalizeLabel(s.label) === key) return true
    const c = cellAt(g, center(s.rect))
    return c.row === cell.row && c.col === cell.col
  })
}

/**
 * The label a space moved into `cell` should take: the cell's, unless the space has a name that isn't a
 * row-number label, the cell is outside the lettered rows and numbered columns, or another active space
 * already uses it. `note` says why a label was kept.
 */
export function relabelForCell(spaces: DraftSpace[], spaceId: string, cell: Cell): { label?: string; note?: string } {
  const space = spaces.find((s) => s.spaceId === spaceId)
  if (!space) return {}
  const parsed = parseLabel(space.label)
  if (!parsed && space.label.trim()) return {} // a custom name such as "Gate" is the admin's
  const target = cellLabel(cell, Math.max(2, parsed?.digits ?? 2))
  if (!target) return { note: `Outside the lettered rows; kept ${space.label.trim() || 'the label'}` }
  if (normalizeLabel(target) === normalizeLabel(space.label)) return {}
  const key = normalizeLabel(target)
  if (spaces.some((s) => !s.retired && s.spaceId !== spaceId && normalizeLabel(s.label) === key)) {
    return { note: `${target} is already used; kept ${space.label}` }
  }
  return { label: target }
}

/** Every active row-number-labeled space moved into its label's cell and given the grid's box size. */
export function arrangeByLabels(draft: DraftLayout, g: Grid): { draft: DraftLayout; spaceIds: string[] } {
  const spaceIds: string[] = []
  const spaces = draft.spaces.map((s) => {
    const p = s.retired ? null : parseLabel(s.label)
    if (!p) return s
    const rect = cellRect(g, { row: rowIndex(p.row), col: p.num - 1 })
    if (rect.x === s.rect.x && rect.y === s.rect.y && rect.w === s.rect.w && rect.h === s.rect.h) return s
    spaceIds.push(s.spaceId)
    return { ...s, rect }
  })
  return { draft: spaceIds.length ? { ...draft, spaces } : draft, spaceIds }
}

/** Most grid lines drawn per direction; zoomed far out, the grid is left out rather than drawn as a blur. */
const MAX_LINES = 300

/** Cell boundaries, row indices and column indices inside a view (schematic units). */
export function gridInView(
  g: Grid,
  view: { x: number; y: number; w: number; h: number },
): { xs: number[]; ys: number[]; rows: number[]; cols: number[] } {
  const span = (lo: number, hi: number, origin: number, step: number) => {
    const first = Math.ceil((lo - origin) / step)
    const last = Math.floor((hi - origin) / step)
    return last - first + 1 > MAX_LINES ? [] : Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i)
  }
  const xk = span(view.x, view.x + view.w, g.x0, g.cellW)
  const yk = span(view.y, view.y + view.h, g.y0, g.cellH)
  return {
    xs: xk.map((k) => g.x0 + k * g.cellW),
    ys: yk.map((k) => g.y0 + k * g.cellH),
    // A cell is labeled when its middle is in view.
    cols: span(view.x - g.cellW / 2, view.x + view.w - g.cellW / 2, g.x0, g.cellW),
    rows: span(view.y - g.cellH / 2, view.y + view.h - g.cellH / 2, g.y0, g.cellH),
  }
}

/** The grid moved by a uniform shift of every space (fitSchematic growing the map left or up). */
export const shiftGrid = (g: Grid, dx: number, dy: number): Grid => ({ ...g, x0: r2(g.x0 + dx), y0: r2(g.y0 + dy) })
