import type { DraftLayout, DraftRect, DraftSpace, Point } from '../types'
import { DEFAULT_SIZE, GAP, MARGIN, MIN_SIDE, medianSize, type Corner } from './geometry'
import { formatLabel, normalizeLabel, parseLabel } from './labels'

// The schematic grid: rows are lettered (row 0 is A, then B ... Z, AA ...) and columns numbered from 1,
// so the cell a space sits in is its label: row C, column 7 is C-07. Each cell holds one space-sized box
// with half the gap on each side. Lots come as rows back to back with a drive aisle between pairs, so a
// row may sit further down than the pitch says: an aisle before it adds that space, and every row after
// it moves down with it. Pure; the mapping page keeps the grid it uses (useSchematicGrid).

export interface Grid {
  x0: number // left edge of column 0's cells
  y0: number // top edge of row 0's (row A's) cells, aisles aside
  cellW: number // column pitch: box width plus the gap across
  cellH: number // row pitch: box height plus the gap down
  boxW: number
  boxH: number
  /** Extra space above `row` (a drive aisle), by row; left out when there is none. */
  aisles?: Aisle[]
}

export interface Aisle {
  row: number
  gap: number
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

/** All aisles above `row` (and the one right before it). */
function aisleSpace(g: Grid, row: number): number {
  return (g.aisles ?? []).reduce((sum, a) => (a.row <= row ? sum + a.gap : sum), 0)
}

/** Top edge of a row's cells. */
export const rowTop = (g: Grid, row: number): number => g.y0 + row * g.cellH + aisleSpace(g, row)

/** The row at height `y`: in an aisle, the nearer of the rows on either side. */
export function rowAt(g: Grid, y: number): number {
  let t = y - g.y0
  for (const a of g.aisles ?? []) {
    const start = a.row * g.cellH // where row a.row would start without this aisle (earlier ones taken off)
    if (t < start) break
    if (t < start + a.gap) return t - start < a.gap / 2 ? a.row - 1 : a.row
    t -= a.gap
  }
  return Math.floor(t / g.cellH)
}

/**
 * The aisles between labeled rows whose tops (`rowY`) are further apart than `cellH` per row: anything
 * over a quarter row more is an aisle before the lower row. Smaller differences are the rows' own noise.
 */
function fitAisles(rowY: Map<number, number>, cellH: number): Aisle[] {
  const rows = [...rowY.keys()].sort((a, b) => a - b)
  return rows.slice(1).flatMap((r, i) => {
    const extra = rowY.get(r)! - rowY.get(rows[i])! - (r - rows[i]) * cellH
    return extra > 0.25 * cellH ? [{ row: r, gap: r2(extra) }] : []
  })
}

const withAisles = (g: Grid, aisles: Aisle[]): Grid => (aisles.length > 0 ? { ...g, aisles } : g)

export const gridSizes = (g: Grid): GridSizes => ({
  boxW: g.boxW,
  boxH: g.boxH,
  gapX: r2(g.cellW - g.boxW),
  gapY: r2(g.cellH - g.boxH),
})

/**
 * The grid the spaces' labels describe: a space labeled C-07 sits in row C, column 7. The column pitch
 * and the origin are medians (from neighbouring numbers within a row), so a few misplaced spaces don't
 * skew it. The row pitch is the closest any two neighbouring rows sit (rows back to back); rows further
 * apart than that have an aisle between them. `sizes` replaces any of the fitted sizes.
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
  // Back to back, rows step by a box height and the gap: the closest pair (a hair under a box allowed).
  const pitchH = rowSteps.filter((d) => d >= 0.9 * size.h).reduce<number | null>((a, d) => (a == null ? d : Math.min(a, d)), null)
  const boxW = r2(sizes.boxW ?? size.w)
  const boxH = r2(sizes.boxH ?? size.h)
  const gapX = r2(sizes.gapX ?? (pitchW != null && pitchW >= size.w ? pitchW - size.w : GAP))
  const gapY = r2(sizes.gapY ?? (pitchH != null ? Math.max(0, pitchH - size.h) : GAP))
  const cellW = Math.max(MIN_SIDE, boxW + gapX)
  const cellH = Math.max(MIN_SIDE, boxH + gapY)

  const aisles = fitAisles(rowY, cellH)
  const flat: Grid = { x0: 0, y0: 0, cellW, cellH, boxW, boxH, aisles }
  const left = median(labeled.map((l) => l.rect.x - l.col * cellW)) ?? MARGIN
  const top = median(labeled.map((l) => l.rect.y - rowTop(flat, l.row))) ?? MARGIN
  return withAisles({ x0: r2(left - gapX / 2), y0: r2(top - gapY / 2), cellW, cellH, boxW, boxH }, aisles)
}

export function cellAt(g: Grid, [x, y]: Point): Cell {
  return { row: rowAt(g, y), col: Math.floor((x - g.x0) / g.cellW) }
}

/** The box a space fills in `cell`. */
export function cellRect(g: Grid, { row, col }: Cell): DraftRect {
  return {
    x: r2(g.x0 + col * g.cellW + (g.cellW - g.boxW) / 2),
    y: r2(rowTop(g, row) + (g.cellH - g.boxH) / 2),
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

/** The top (or with `bottom`, the bottom) edge of a row's box nearest `y`. */
function nearestBoxEdge(g: Grid, y: number, bottom: boolean): number {
  const edge = (row: number) => rowTop(g, row) + (g.cellH - g.boxH) / 2 + (bottom ? g.boxH : 0)
  const row = rowAt(g, y)
  return [row - 1, row, row + 1].map(edge).reduce((best, e) => (Math.abs(e - y) < Math.abs(best - y) ? e : best))
}

/** A resized space's dragged edges land on box edges, so it covers whole cells; the other edges stay. */
export function snapResize(g: Grid, rect: DraftRect, corner: Corner): DraftRect {
  const leftOf = g.x0 + (g.cellW - g.boxW) / 2
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.w
  let bottom = rect.y + rect.h
  if (corner.endsWith('w')) left = Math.min(onLattice(left, leftOf, g.cellW), right - MIN_SIDE)
  else right = Math.max(onLattice(right, leftOf + g.boxW, g.cellW), left + MIN_SIDE)
  if (corner.startsWith('n')) top = Math.min(nearestBoxEdge(g, top, false), bottom - MIN_SIDE)
  else bottom = Math.max(nearestBoxEdge(g, bottom, true), top + MIN_SIDE)
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

/** Share of a cell's box a space may cover before the cell counts as taken (a wide stall beside it). */
const OVERLAP_TAKEN = 0.25

function overlapArea(a: DraftRect, b: DraftRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Whether an active space other than `exceptId` uses `label`, sits (by its middle) in `cell`, or covers
 * a good part of the cell's box (a wide space reaching into it).
 */
export function cellTaken(g: Grid, spaces: DraftSpace[], cell: Cell, label: string | null, exceptId?: string): boolean {
  const key = label && normalizeLabel(label)
  const box = cellRect(g, cell)
  return spaces.some((s) => {
    if (s.retired || s.spaceId === exceptId) return false
    if (key && normalizeLabel(s.label) === key) return true
    const c = cellAt(g, center(s.rect))
    return (c.row === cell.row && c.col === cell.col) || overlapArea(s.rect, box) > OVERLAP_TAKEN * box.w * box.h
  })
}

/** Whether a label may be replaced by a cell label: a row-number label or a blank one, never a name like "Gate". */
const renamable = (label: string) => !label.trim() || parseLabel(label) !== null

const sameCell = (a: Cell, b: Cell) => a.row === b.row && a.col === b.col

/**
 * The labels after `spaceId` lands in `cell`. It takes the cell's label (row letter and column number).
 * Another active space that already had that label is renamed for the cell it sits in, when that label
 * is free; otherwise both keep it and the editor flags the duplicate. A name like "Gate", and a cell above
 * row A or left of column 1, keep their label. `note` says what happened.
 */
export function relabelMoved(g: Grid, spaces: DraftSpace[], spaceId: string, cell: Cell): { labels: Map<string, string>; note?: string } {
  const labels = new Map<string, string>()
  const space = spaces.find((s) => s.spaceId === spaceId)
  if (!space || !renamable(space.label)) return { labels }
  const digits = Math.max(2, parseLabel(space.label)?.digits ?? labelDigits(spaces))
  const target = cellLabel(cell, digits)
  if (!target) return { labels, note: `Outside the lettered rows; kept ${space.label.trim() || 'the label'}` }
  const key = normalizeLabel(target)
  if (key === normalizeLabel(space.label)) return { labels }
  labels.set(spaceId, target)
  const notes = [`Now ${target}`]
  const others = spaces.filter((s) => !s.retired && s.spaceId !== spaceId && normalizeLabel(s.label) === key)
  // Labels in use once the move is done: the moved space's old label is free, its new one is taken, and
  // so is each label given out below. A retired space's label may be reused, as the server allows.
  const used = new Set(
    spaces.filter((s) => !s.retired && s.spaceId !== spaceId && !others.includes(s)).map((s) => normalizeLabel(s.label)),
  )
  used.add(key)
  for (const other of others) {
    const own = cellLabel(cellAt(g, center(other.rect)), Math.max(2, parseLabel(other.label)?.digits ?? digits))
    if (own && !used.has(normalizeLabel(own))) {
      labels.set(other.spaceId, own)
      used.add(normalizeLabel(own))
      notes.push(`the space that was ${target} is now ${own}`)
    } else {
      notes.push(`another space is also ${target}; rename one of them`)
    }
  }
  return { labels, note: notes.join('; ') }
}

/**
 * `spaceId` becomes 01 of `row`, in its first cell, and the row's other active row-number spaces move up
 * one number and one cell to make room: all of them, or when the space already belongs to the row, only
 * those numbered below it (its old number's hole closes). For a space put before the row's first number.
 * Null when the row has no letter, or a space that doesn't shift (a name like "Gate", or another row's)
 * sits in a cell the shifted spaces need.
 */
export function insertAtRowStart(draft: DraftLayout, g: Grid, spaceId: string, row: number): DraftLayout | null {
  const letter = rowLetter(row)
  const space = draft.spaces.find((s) => s.spaceId === spaceId)
  if (!letter || !space) return null
  const own = parseLabel(space.label)
  const below = own && own.row === letter ? own.num : Infinity
  const digits = Math.max(2, own?.digits ?? labelDigits(draft.spaces))
  const sits = cellAt(g, center(space.rect))
  // The row's 01 dragged out of its own cell: nothing to shift, it just goes back into column 1.
  if (own && own.row === letter && own.num === 1 && sits.row === row && sits.col === 0) return null
  const shifting = (s: DraftSpace) => {
    const p = s.retired || s.spaceId === spaceId ? null : parseLabel(s.label)
    return p && p.row === letter && p.num < below ? p : null
  }
  const shifted = draft.spaces.flatMap((s) => {
    const p = shifting(s)
    return p ? [p.num] : []
  })
  const needed = [0, ...shifted]
  const blocked = draft.spaces.some((s) => {
    if (s.retired || s.spaceId === spaceId || shifting(s)) return false
    const c = cellAt(g, center(s.rect))
    return c.row === row && needed.includes(c.col)
  })
  if (blocked) return null
  const spaces = draft.spaces.map((s) => {
    if (s.spaceId === spaceId) return { ...s, label: formatLabel(letter, 1, digits), rect: cellRect(g, { row, col: 0 }) }
    const p = shifting(s)
    return p ? { ...s, label: formatLabel(p.row, p.num + 1, p.digits), rect: cellRect(g, { row, col: p.num }) } : s
  })
  return { ...draft, spaces }
}

/** The draft with `labels` (space id -> label) applied. */
export function applyLabels(draft: DraftLayout, labels: Map<string, string>): DraftLayout {
  if (labels.size === 0) return draft
  return { ...draft, spaces: draft.spaces.map((s) => (labels.has(s.spaceId) ? { ...s, label: labels.get(s.spaceId)! } : s)) }
}

/**
 * Align all to grid: every active space snaps into the cell it already sits in (by its middle), at the
 * grid's box size, and takes that cell's label. When two spaces would share a cell, the later one (top to
 * bottom, left to right) takes the nearest free cell within two columns, or is left where it is. Names
 * like "Gate" are kept, and so is a label another space keeps.
 */
export function alignToCells(draft: DraftLayout, g: Grid): { draft: DraftLayout; moved: number; renamed: number; left: number } {
  // Row by row (by cell, so a slightly uneven row still goes left to right), then left to right.
  const active = draft.spaces
    .filter((s) => !s.retired)
    .map((s) => ({ s, c: center(s.rect) }))
    .map((a) => ({ ...a, row: cellAt(g, a.c).row }))
    .sort((a, b) => a.row - b.row || a.c[0] - b.c[0])
  const taken: Cell[] = []
  const placed = new Map<string, Cell>()
  let left = 0
  for (const { s, c } of active) {
    const home = cellAt(g, c)
    const options = [0, -1, 1, -2, 2]
      .map((d) => ({ row: home.row, col: home.col + d }))
      .sort((a, b) => Math.abs(cellRect(g, a).x + g.boxW / 2 - c[0]) - Math.abs(cellRect(g, b).x + g.boxW / 2 - c[0]))
    const cell = options.find((o) => !taken.some((t) => sameCell(t, o)))
    if (!cell) {
      left++
      continue
    }
    taken.push(cell)
    placed.set(s.spaceId, cell)
  }
  // Labels kept as they are: names, spaces left in place, and cells outside the lettered rows.
  const digits = labelDigits(draft.spaces)
  const next = new Map<string, string>()
  for (const { s } of active) {
    const cell = placed.get(s.spaceId)
    const label = cell && renamable(s.label) ? cellLabel(cell, Math.max(2, parseLabel(s.label)?.digits ?? digits)) : null
    if (label) next.set(s.spaceId, label)
  }
  // A space that can't take its cell's label (another space keeps that label) keeps its own, which then
  // can't be handed out either; repeat until no new label clashes with a kept one.
  const kept = new Set(active.filter(({ s }) => !next.has(s.spaceId)).map(({ s }) => normalizeLabel(s.label)))
  for (let changed = true; changed; ) {
    changed = false
    for (const { s } of active) {
      const label = next.get(s.spaceId)
      if (label && kept.has(normalizeLabel(label)) && normalizeLabel(label) !== normalizeLabel(s.label)) {
        next.delete(s.spaceId)
        kept.add(normalizeLabel(s.label))
        changed = true
      }
    }
  }
  let moved = 0
  let renamed = 0
  const spaces = draft.spaces.map((s) => {
    const cell = placed.get(s.spaceId)
    if (!cell) return s
    const rect = cellRect(g, cell)
    const label = next.get(s.spaceId)
    const relabel = label && normalizeLabel(label) !== normalizeLabel(s.label) ? label : null
    const shifted = rect.x !== s.rect.x || rect.y !== s.rect.y || rect.w !== s.rect.w || rect.h !== s.rect.h
    if (!shifted && !relabel) return s
    if (shifted) moved++
    if (relabel) renamed++
    return { ...s, rect, ...(relabel ? { label: relabel } : {}) }
  })
  return { draft: moved || renamed ? { ...draft, spaces } : draft, moved, renamed, left }
}

/** How far (rows or columns) a space may sit from its label's cell for Fit grid to go by the label. */
const LABEL_REACH = 2

/**
 * Fit grid to one space: the grid shifts and resizes so `rect` exactly fills its label's cell (C-07: row
 * C, column 7) when that is within LABEL_REACH of where it sits, else (a name like "Gate", or a label
 * far off, likely a mistake) the cell it sits in; the gaps are kept.
 */
export function anchorGrid(g: Grid, rect: DraftRect, label = ''): Grid {
  const gapX = g.cellW - g.boxW
  const gapY = g.cellH - g.boxH
  const cellW = rect.w + gapX
  const cellH = rect.h + gapY
  const parsed = parseLabel(label)
  const sits = cellAt(g, center(rect))
  const named = parsed && { row: rowIndex(parsed.row), col: parsed.num - 1 }
  const near = named && Math.abs(named.row - sits.row) <= LABEL_REACH && Math.abs(named.col - sits.col) <= LABEL_REACH
  const { row, col } = near ? named : sits
  return withAisles(
    {
      x0: r2(rect.x - col * cellW - gapX / 2),
      y0: r2(rect.y - row * cellH - aisleSpace(g, row) - gapY / 2),
      cellW: r2(cellW),
      cellH: r2(cellH),
      boxW: rect.w,
      boxH: rect.h,
    },
    g.aisles ?? [],
  )
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
  // Rows by their top and bottom edges: an aisle leaves a gap between one row's bottom and the next top.
  const first = rowAt(g, view.y) - 1
  const last = rowAt(g, view.y + view.h) + 1
  const inView = (y: number) => y >= view.y && y <= view.y + view.h
  const ys: number[] = []
  const rows: number[] = []
  if (last - first < MAX_LINES) {
    for (let row = first; row <= last; row++) {
      const top = rowTop(g, row)
      for (const y of [top, top + g.cellH]) if (inView(y) && !ys.some((v) => Math.abs(v - y) < 1e-6)) ys.push(y)
      // A cell is labeled when its middle is in view.
      if (inView(top + g.cellH / 2)) rows.push(row)
    }
  }
  return {
    xs: xk.map((k) => g.x0 + k * g.cellW),
    ys,
    cols: span(view.x - g.cellW / 2, view.x + view.w - g.cellW / 2, g.x0, g.cellW),
    rows,
  }
}

/** The grid moved by a uniform shift of every space (fitSchematic growing the map left or up). */
export const shiftGrid = (g: Grid, dx: number, dy: number): Grid => ({ ...g, x0: r2(g.x0 + dx), y0: r2(g.y0 + dy) })
