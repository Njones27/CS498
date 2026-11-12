import type { components } from '../api/types.gen'
import { MARGIN, MIN_SIDE, yBelowAll } from './schematic/geometry'
import { addSpacesAt, deleteSpace, fitSchematic, leanLikeRows, removeSpaces, type Grown } from './schematic/edits'
import { formatLabel, nextRowStart, parseLabel } from './schematic/labels'
import { cellAt, cellRect, type Grid, shiftGrid } from './schematic/grid'
import { touchesPhotoEdge } from './photo/geom'
import { addSpaceFromOutline, centroid, outlineToRect, photoToSchematic } from './sync'
import type { DraftLayout, DraftRect, DraftSpace, DraftViewpoint, OutlineReview, Outline, Point } from './types'

// Stalls found by the layout proposer (HDD §4.6), merged into the draft for review. Pure: every edit
// returns a new DraftLayout. A proposer stall becomes a new space with a pending proposed outline that
// carries its evidence score; the admin accepts or rejects it on the photo, weakest first.

export type ProposedStall = components['schemas']['ProposedStall']
export type ProposalRun = components['schemas']['ProposalRunOut']

/** A stall flattened onto the map is drawn at least this wide, at most this wide (schematic units). */
const MIN_STALL_W = 30
const MAX_STALL_W = 110

/** Why found stalls could not be added: the lot has spaces this photo cannot be matched to yet. */
export const NEEDS_ANCHORS =
  'Outline 4 of this lot\'s spaces on this photo first, so the stalls found can be matched to the spaces you already have.'

/** Ray casting: is `p` inside the polygon? */
export function insidePolygon([x, y]: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** A stall that lands on an outline already in the view (either one's middle inside the other). */
function alreadyOutlined(view: DraftViewpoint, stall: Outline): boolean {
  const mid = centroid(stall)
  return Object.values(view.outlines).some((o) => insidePolygon(mid, o) || insidePolygon(centroid(o), stall))
}

/** Rejected stalls kept per viewpoint; the oldest go first (the API takes at most this many). */
export const MAX_REJECTED = 1000

/**
 * A found stall is one the admin rejected when the two overlap this much (intersection over union),
 * so a stall found a little off counts, but the real stalls inside a rejected wide one (half of it
 * each) don't.
 */
const REJECTED_OVERLAP = 0.6

function wasRejected(view: DraftViewpoint, stall: Outline): boolean {
  const a = area(stall)
  return (view.rejectedStalls ?? []).some((r) => {
    const b = area(r as Point[])
    if (b <= 0) return false // squashed flat: it covers nothing
    const shared = area(clipPolygon(stall, r as Point[]))
    return shared >= REJECTED_OVERLAP * (a + b - shared)
  })
}

/** Rows back to back on the photo are at most this share of a stall's depth apart; further is an aisle. */
const BACK_TO_BACK = 0.5

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

/**
 * A new lot's stalls on a clean grid, for a lot with too few outlines to place by the photo fit: every
 * stall the same size, in the cell its label names, so the schematic grid fits them exactly (labels,
 * snapping and drawing all line up). Proposer rows become the next free row letters, top to bottom, under
 * any spaces already there; rows back to back on the photo touch, and a drive between them stays as an
 * aisle, scaled like the photo. Stalls are numbered left to right; a row starting further right than the
 * others starts at the matching column (C-03, say). The map is scaled to its width, within a sensible
 * stall size. A label is undefined past row Z (the space then keeps its place, unnamed).
 */
function layoutOnGrid(draft: DraftLayout, stalls: ProposedStall[]): { rect: DraftRect; label?: string }[] {
  const left = Math.min(...stalls.map((s) => s.mapRect.x))
  const width = Math.max(...stalls.map((s) => s.mapRect.x + s.mapRect.w)) - left
  const stallW = median(stalls.map((s) => s.mapRect.w))
  const stallH = median(stalls.map((s) => s.mapRect.h))
  let scale = (draft.schematic.width - 2 * MARGIN) / width
  scale = Math.min(Math.max(scale, MIN_STALL_W / stallW), MAX_STALL_W / stallW)
  const boxW = Math.max(MIN_SIDE, Math.round(stallW * scale))
  const boxH = Math.max(MIN_SIDE, Math.round(stallH * scale))

  const first = parseLabel(nextRowStart(draft.spaces))?.row
  const rows = [...new Set(stalls.map((s) => s.row))].sort((a, b) => a - b)
  const out = new Map<ProposedStall, { rect: DraftRect; label?: string }>()
  let y = draft.spaces.length > 0 ? yBelowAll(draft.spaces) : MARGIN
  let prevBottom: number | null = null
  rows.forEach((row, i) => {
    const inRow = stalls.filter((s) => s.row === row).sort((a, b) => a.mapRect.x - b.mapRect.x)
    const top = median(inRow.map((s) => s.mapRect.y))
    if (prevBottom != null) {
      const gap = top - prevBottom
      y += boxH + (gap > BACK_TO_BACK * stallH ? Math.round(gap * scale) : 0)
    }
    prevBottom = top + median(inRow.map((s) => s.mapRect.h))
    const code = first && first.length === 1 ? first.charCodeAt(0) + i : NaN
    const letter = code <= 'Z'.charCodeAt(0) ? String.fromCharCode(code) : undefined
    const start = Math.max(0, Math.round((inRow[0].mapRect.x - left) / stallW))
    inRow.forEach((s, k) => {
      const col = start + k
      out.set(s, { rect: { x: MARGIN + col * boxW, y, w: boxW, h: boxH }, label: letter && formatLabel(letter, col + 1) })
    })
  })
  return stalls.map((s) => out.get(s)!)
}

export interface MergeResult extends Grown {
  /** New spaces created for stalls. */
  added: number
  /** Stalls attached to a space the lot already had (outlined in another view, or on the map only). */
  attached: number
  /** Stalls left out: already outlined in this view, or not placeable on the map. */
  skipped: number
  /** Stalls left out because the admin rejected them on an earlier run (see `rejectProposals`). */
  rejected: number
  /** Set when nothing was merged because the stalls cannot be matched to the lot's spaces. */
  blocked?: string
  /** Wide stalls the lot has drawn as more than one space (see `findWideStalls`). */
  wide: WideStall[]
  /** Space IDs created for stalls in this run. */
  createdIds?: ReadonlySet<string>
}

/** One stall on the photo, wider than its row's others, that the lot has drawn as several spaces. */
export interface WideStall {
  stall: ProposedStall
  /** The spaces drawn in it, left to right on the photo; the first one is kept by `mergeWideStalls`. */
  spaceIds: string[]
}

/**
 * How much ground each outline covers, against what a typical stall covers at its spot on the photo:
 * 1 for a stall like the others, 1.5 for a bay half as wide again. A camera at an angle draws stalls
 * near it far bigger than those across the lot, so raw areas can't be compared. On flat ground the
 * cube root of a stall's area on the photo grows linearly across the photo (the ground-to-photo map's
 * scale), so that is fitted over the outlines and each is measured against the fit at its middle.
 * The fit stands on the FIT_SHARE of outlines it fits best (trimmed least squares), so wide bays and
 * loose outlines, up to the rest of them, are left out of it rather than pulling it their way. An
 * overhead photo fits a constant; a view of fewer than MIN_SLOPE_FIT outlines is measured against its
 * median (a slope across the photo needs more to stand on).
 */
export function groundSizes(outlines: Outline[]): number[] {
  const n = outlines.length
  if (n === 0) return []
  const mids = outlines.map((o) => centroid(o))
  const sizes = outlines.map((o) => Math.cbrt(area(o as Point[])))
  const typical = median(sizes)
  if (!(typical > 0)) return sizes.map(() => 1)
  // Centred and scaled for a well-conditioned fit.
  const [mx, my] = [mids.reduce((t, p) => t + p[0], 0) / n, mids.reduce((t, p) => t + p[1], 0) / n]
  const spread = Math.sqrt(mids.reduce((t, p) => t + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0) / n) || 1
  const rows = mids.map(([x, y]) => [(x - mx) / spread, (y - my) / spread, 1])
  let fit = [0, 0, typical]
  const expect = (r: number[]) => fit[0] * r[0] + fit[1] * r[1] + fit[2]
  /** Least squares on `on`; a light pull on the slopes keeps one row (all on a line) solvable. */
  const fitOn = (on: number[]) =>
    solve3(
      [0, 1, 2].map((i) => [0, 1, 2].map((k) => on.reduce((t, j) => t + rows[j][i] * rows[j][k], 0) + (i === k && i < 2 ? 1e-6 * n : 0))),
      [0, 1, 2].map((i) => on.reduce((t, j) => t + rows[j][i] * sizes[j], 0)),
    )
  if (n >= MIN_SLOPE_FIT) {
    // From the fit on all of them, refit on the ones it fits best until they stay the same.
    const keep = Math.ceil(FIT_SHARE * n)
    let on = rows.map((_, j) => j)
    for (let it = 0; it < 20; it++) {
      const next = fitOn(on)
      if (!next) break
      fit = next
      const best = rows.map((r, j) => ({ j, miss: Math.abs(sizes[j] - expect(r)) })).sort((p, q) => p.miss - q.miss).slice(0, keep).map((m) => m.j).sort((p, q) => p - q)
      if (best.length === on.length && best.every((j, k) => j === on[k])) break
      on = best
    }
  }
  // Past the outlines (towards the horizon) the fit can run small; it never says a stall is under half
  // the typical size, which would make a loose outline there look like a bay.
  return rows.map((r, j) => (sizes[j] / Math.max(expect(r), 0.5 * typical)) ** 3)
}

/** Share of a view's outlines its ground fit stands on (see `groundSizes`). */
const FIT_SHARE = 0.6
/** Fewest outlines that fit a slope across the photo. */
const MIN_SLOPE_FIT = 6

/** Cramer's rule for a 3 x 3 system; null when singular. */
function solve3(a: number[][], b: number[]): number[] | null {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const d = det(a)
  if (!(Math.abs(d) > 1e-12)) return null
  return [0, 1, 2].map((c) => det(a.map((row, i) => row.map((v, k) => (k === c ? b[i] : v)))) / d)
}

/** A stall is drawn wider than one cell only when it is this much bigger than its row's typical one on
 * the ground: outlines (car boxes, hand-drawn ones) miss their stall by up to about a third. */
const WIDE_ON_MAP = 1.4

/**
 * Rows the photo shows with wide stalls in them (WIDE_ON_MAP times the row's typical stall on the
 * ground, see `groundSizes`) are laid out again left to right as the photo has them: each space as wide
 * as its stall (whole and half cells), side by side from where the row starts, so a row of wide bays
 * lines up with the rows beside it instead of leaving holes. Labels stay; rows with no wide stall are
 * left as they are.
 */
export function alignRowsToPhoto(draft: DraftLayout, viewId: string): DraftLayout {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) return draft
  const key = (r: DraftRect) => `${Math.round(r.y)}:${Math.round(r.h)}`
  const rows = new Map<string, DraftSpace[]>()
  const outlined = draft.spaces.filter((sp) => !sp.retired && view.outlines[sp.spaceId])
  const sizes = groundSizes(outlined.map((sp) => view.outlines[sp.spaceId]))
  const size = new Map(outlined.map((sp, k) => [sp.spaceId, sizes[k]]))
  for (const sp of outlined) rows.set(key(sp.rect), [...(rows.get(key(sp.rect)) ?? []), sp])
  const moved = new Map<string, DraftRect>()
  for (const row of rows.values()) {
    if (row.length < 3) continue
    const areas = row.map((sp) => size.get(sp.spaceId)!)
    const typical = median(areas)
    if (!(typical > 0) || !areas.some((a) => a >= WIDE_ON_MAP * typical)) continue
    const order = row.map((sp, k) => ({ sp, a: areas[k], x: centroid(view.outlines[sp.spaceId] as Outline)[0] })).sort((p, q) => p.x - q.x)
    const cell = Math.min(...row.map((sp) => sp.rect.w))
    const gaps = [...row].sort((p, q) => p.rect.x - q.rect.x)
    const gap = Math.max(0, Math.min(...gaps.slice(1).map((sp, k) => sp.rect.x - (gaps[k].rect.x + gaps[k].rect.w))))
    let x = Math.min(...row.map((sp) => sp.rect.x))
    for (const { sp, a } of order) {
      // Whole and half cells; one under WIDE_ON_MAP is one cell.
      const cells = a < WIDE_ON_MAP * typical ? 1 : Math.round((2 * a) / typical) / 2
      const w = Math.round((cells * cell + (cells - 1) * gap) * 100) / 100
      moved.set(sp.spaceId, { ...sp.rect, x: Math.round(x * 100) / 100, w })
      x += w + gap
    }
  }
  if (moved.size === 0) return draft
  return fitSchematic({ ...draft, spaces: draft.spaces.map((sp) => (moved.has(sp.spaceId) ? { ...sp, rect: moved.get(sp.spaceId)! } : sp)) }).draft
}

/** A stall this much wider than its row's typical one (by area) is a wide stall (an accessible bay, say). */
const WIDE = 1.3
/** A space is drawn in a wide stall when at least this share of its outline lies inside it: a space
 * only reaching into it (a missed divider beside it, say) is not. */
const INSIDE = 0.45

/** Area of a polygon (shoelace). */
export function area(poly: Point[]): number {
  let a = 0
  poly.forEach(([x, y], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length]
    a += x * y2 - x2 * y
  })
  return Math.abs(a) / 2
}

/** The part of `subject` inside the convex polygon `clip` (Sutherland-Hodgman). */
export function clipPolygon(subject: Point[], clip: Point[]): Point[] {
  const sign = Math.sign(
    clip.reduce((t, [x, y], i) => {
      const [x2, y2] = clip[(i + 1) % clip.length]
      return t + x * y2 - x2 * y
    }, 0),
  )
  let out = subject
  clip.forEach((a, i) => {
    const b = clip[(i + 1) % clip.length]
    const inside = ([x, y]: Point) => sign * ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) >= 0
    const input = out
    out = []
    input.forEach((p, k) => {
      const q = input[(k + 1) % input.length]
      const [pin, qin] = [inside(p), inside(q)]
      if (pin) out.push(p)
      if (pin !== qin) {
        const [dx, dy] = [q[0] - p[0], q[1] - p[1]]
        const [ex, ey] = [b[0] - a[0], b[1] - a[1]]
        const t = (ex * (a[1] - p[1]) - ey * (a[0] - p[0])) / (ex * dy - ey * dx)
        out.push([p[0] + t * dx, p[1] + t * dy])
      }
    })
  })
  return out
}

/**
 * Normalized width of a stall polygon (width along the row / depth across the row),
 * scale-invariant across perspective.
 */
export function normalizedStallWidth(poly: Point[], rowDir: Point = [1, 0]): number {
  if (poly.length < 3) return 0
  const mag = Math.hypot(rowDir[0], rowDir[1])
  const u: Point = mag > 0 ? [rowDir[0] / mag, rowDir[1] / mag] : [1, 0]

  if (poly.length === 4) {
    const d = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1])
    const s0 = d(poly[0], poly[1])
    const s1 = d(poly[1], poly[2])
    const s2 = d(poly[2], poly[3])
    const s3 = d(poly[3], poly[0])
    const e0: Point = [poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]]
    const e1: Point = [poly[2][0] - poly[1][0], poly[2][1] - poly[1][1]]
    const dot0 = s0 > 0 ? Math.abs((e0[0] * u[0] + e0[1] * u[1]) / s0) : 0
    const dot1 = s1 > 0 ? Math.abs((e1[0] * u[0] + e1[1] * u[1]) / s1) : 0
    const [width, depth] = dot0 >= dot1 ? [(s0 + s2) / 2, (s1 + s3) / 2] : [(s1 + s3) / 2, (s0 + s2) / 2]
    if (depth > 0) return width / depth
  }

  const uPerp: Point = [-u[1], u[0]]
  const projsU = poly.map((p) => p[0] * u[0] + p[1] * u[1])
  const projsV = poly.map((p) => p[0] * uPerp[0] + p[1] * uPerp[1])
  const width = Math.max(...projsU) - Math.min(...projsU)
  const depth = Math.max(...projsV) - Math.min(...projsV)
  return depth > 0 ? width / depth : 0
}

/**
 * Stalls on the photo wider than the others in their row (WIDE times their typical normalized width) that the lot
 * has drawn as two or more spaces in this view: a space belongs to the wide stall holding most of its
 * outline (INSIDE of it at least). Four wide bays drawn as six narrow spaces, for one, give the lot two
 * spaces too many; `mergeWideStalls` puts each back as one space.
 */
export function findWideStalls(draft: DraftLayout, viewId: string, stalls: ProposedStall[]): WideStall[] {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) return []

  const rowGroups = new Map<number, ProposedStall[]>()
  for (const s of stalls) {
    const list = rowGroups.get(s.row) ?? []
    list.push(s)
    rowGroups.set(s.row, list)
  }

  const wide: ProposedStall[] = []
  for (const [, rowStalls] of rowGroups) {
    const sorted = [...rowStalls].sort((a, b) => a.col - b.col)
    let rowDir: Point = [1, 0]
    if (sorted.length >= 2) {
      const c0 = centroid(sorted[0].polygon as Outline)
      const cLast = centroid(sorted[sorted.length - 1].polygon as Outline)
      const dx = cLast[0] - c0[0]
      const dy = cLast[1] - c0[1]
      if (Math.hypot(dx, dy) > 0) rowDir = [dx, dy]
    }

    const scores = new Map<ProposedStall, number>()
    for (const s of sorted) {
      scores.set(s, normalizedStallWidth(s.polygon as Point[], rowDir))
    }

    for (const s of sorted) {
      if (s.partial) continue
      const neighbors = sorted
        .filter((other) => other !== s && !other.partial)
        .sort((a, b) => Math.abs(a.col - s.col) - Math.abs(b.col - s.col))
        .slice(0, 4)
      if (neighbors.length === 0) continue
      const neighborScores = neighbors.map((n) => scores.get(n)!).sort((a, b) => a - b)
      const typical = neighborScores[Math.floor((neighborScores.length - 1) / 2)]
      const sScore = scores.get(s)!
      if (sScore >= WIDE * typical) {
        wide.push(s)
      }
    }
  }

  if (wide.length === 0) return []
  const home = new Map<ProposedStall, string[]>()
  for (const sp of draft.spaces) {
    const outline = view.outlines[sp.spaceId] as Point[] | undefined
    if (sp.retired || !outline || outline.length < 3) continue
    const own = area(outline)
    let best: ProposedStall | null = null
    let most = 0
    for (const w of wide) {
      const share = area(clipPolygon(outline, w.polygon as Point[])) / (own || 1)
      if (share >= INSIDE && share > most) [best, most] = [w, share]
    }
    if (best) home.set(best, [...(home.get(best) ?? []), sp.spaceId])
  }
  const x = (id: string) => centroid(view.outlines[id] as Outline)[0]
  return [...home]
    .filter(([, ids]) => ids.length >= 2)
    .map(([stall, ids]) => ({ stall, spaceIds: [...ids].sort((a, b) => x(a) - x(b)) }))
}

/**
 * Each wide stall drawn as several spaces becomes one: the first space is kept, spanning all their
 * cells on the map, with the wide stall's outline proposed for review; the other spaces are deleted
 * if they were never published, or retired (keeping history) if they were published. Undo takes it back.
 */
export function mergeWideStalls(
  draft: DraftLayout,
  viewId: string,
  wide: WideStall[],
  publishedSpaceIds: ReadonlySet<string> = new Set(),
): DraftLayout {
  const keep = new Map<string, WideStall>()
  const remove = new Set<string>()
  for (const w of wide) {
    keep.set(w.spaceIds[0], w)
    w.spaceIds.slice(1).forEach((id) => remove.add(id))
  }
  const rectOf = (id: string) => draft.spaces.find((sp) => sp.spaceId === id)!.rect
  let next: DraftLayout = {
    ...draft,
    spaces: draft.spaces.map((sp) => {
      const w = keep.get(sp.spaceId)
      if (!w) return sp
      const rects = w.spaceIds.map(rectOf)
      const x0 = Math.min(...rects.map((r) => r.x))
      const y0 = Math.min(...rects.map((r) => r.y))
      const x1 = Math.max(...rects.map((r) => r.x + r.w))
      const y1 = Math.max(...rects.map((r) => r.y + r.h))
      return { ...sp, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
    }),
  }
  next = removeSpaces(next, remove, publishedSpaceIds)
  const viewpoints = next.viewpoints.map((v) => {
    const outlines = { ...v.outlines }
    const outlineReview = { ...v.outlineReview }
    for (const id of remove) {
      delete outlines[id]
      delete outlineReview[id]
    }
    if (v.viewId === viewId) {
      for (const [id, w] of keep) {
        outlines[id] = w.stall.polygon as Outline
        outlineReview[id] = { source: 'proposed', status: 'pending', evidence: w.stall.evidence }
      }
    }
    return { ...v, outlines, outlineReview }
  })
  return { ...next, viewpoints }
}

/** Where a stall is, for placing it on the map: the whole stall, even past the photo's border. */
const placement = (stall: ProposedStall): Outline => (stall.wholePolygon ?? stall.polygon) as Outline

const contains = (r: DraftRect, [x, y]: Point) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

/**
 * Add the proposer's stalls to `viewId` as pending proposed outlines. Stalls on an outline already in the
 * view are skipped.
 *
 * With enough outlined spaces to fit the photo to the map, a stall landing on a space that has no outline in
 * this view yet (seen from another viewpoint, or drawn on the map) becomes that space's outline. Every other
 * stall is added exactly like a space drawn on the photo (`addSpaceFromOutline`): with the schematic grid it
 * takes the cell the photo puts it in and is named for it, a stall before a row's first space is inserted at
 * the row start, and the row renumbered. Stalls are added right to left, so those nearest the spaces already
 * placed go first.
 *
 * Without a fit, stalls can only be matched to nothing: on a lot whose spaces are all outlined here (a new
 * lot, typically) they become new spaces laid out on a clean grid (`layoutOnGrid`), rows labeled A, B, C
 * (after any rows in use) and stalls 01 onward; on a lot with spaces this photo does not show yet, nothing is merged
 * (`blocked`), so a second viewpoint never duplicates the stalls of the first.
 */
export function mergeProposals(
  draft: DraftLayout,
  viewId: string,
  stalls: ProposedStall[],
  grid: Grid | null = null,
): MergeResult {
  const wide = findWideStalls(draft, viewId, stalls)
  const none = { draft, dx: 0, dy: 0, added: 0, attached: 0, rejected: 0, wide }
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) return { ...none, skipped: stalls.length }
  const open = stalls.filter((s) => !alreadyOutlined(view, s.polygon as Outline))
  const skipped = stalls.length - open.length
  // Stalls the admin rejected on an earlier run stay rejected.
  const fresh = open.filter((s) => !wasRejected(view, s.polygon as Outline))
  const rejected = open.length - fresh.length
  if (fresh.length === 0) return { ...none, skipped, rejected }

  const unmatched = draft.spaces.filter((sp) => !sp.retired && !view.outlines[sp.spaceId])
  const fit = photoToSchematic(draft, view)
  if (!fit && unmatched.length > 0) return { ...none, skipped, rejected, blocked: NEEDS_ANCHORS }

  // Which space each stall's outline goes to; `created` marks spaces made for a stall.
  const found = new Map<string, ProposedStall>()
  const created = new Set<string>()
  let next = draft
  let dx = 0
  let dy = 0
  if (fit) {
    const free = new Set(unmatched.map((sp) => sp.spaceId))
    const rest: ProposedStall[] = []
    for (const stall of fresh) {
      const rect = outlineToRect(fit, placement(stall))
      const mid: Point | null = rect && [rect.x + rect.w / 2, rect.y + rect.h / 2]
      const space: DraftSpace | undefined = mid
        ? unmatched.find((sp) => free.has(sp.spaceId) && contains(sp.rect, mid))
        : undefined
      if (space) {
        free.delete(space.spaceId)
        found.set(space.spaceId, stall)
      } else {
        rest.push(stall)
      }
    }
    rest.sort((a, b) => centroid(b.polygon as Outline)[0] - centroid(a.polygon as Outline)[0])
    for (const stall of rest) {
      // Placed by the whole stall; its outline becomes the part in view just below.
      const placed = addSpaceFromOutline(next, viewId, placement(stall), grid && shiftGrid(grid, dx, dy))
      next = placed.draft
      dx += placed.dx
      dy += placed.dy
      found.set(placed.space.spaceId, stall)
      created.add(placed.space.spaceId)
    }
  } else {
    const grown = addSpacesAt(draft, layoutOnGrid(draft, fresh))
    next = grown.draft
    dx = grown.dx
    dy = grown.dy
    grown.spaces.forEach((space, i) => {
      found.set(space.spaceId, fresh[i])
      created.add(space.spaceId)
    })
  }

  const target = next.viewpoints.find((v) => v.viewId === viewId)!
  const outlines = { ...target.outlines }
  const outlineReview: Record<string, OutlineReview> = { ...target.outlineReview }
  for (const [spaceId, stall] of found) {
    outlines[spaceId] = stall.polygon as Outline
    outlineReview[spaceId] = { source: 'proposed', status: 'pending', evidence: stall.evidence }
    if (created.has(spaceId)) outlineReview[spaceId].newSpace = true
  }
  next = {
    ...next,
    viewpoints: next.viewpoints.map((v) => (v.viewId === viewId ? { ...v, outlines, outlineReview } : v)),
  }
  // A stall placed in a row of angled stalls leans like them, and rows with wide stalls in them are
  // laid out as wide as the photo shows them.
  next = leanLikeRows(next, created)
  next = alignRowsToPhoto(next, viewId)
  return { draft: next, dx, dy, added: created.size, attached: found.size - created.size, skipped, rejected, wide, createdIds: created }
}

/**
 * Evidence given to a car left out of the rows and put back: under any found car's own (those run from
 * about 0.13 up), so these head the weakest-first review list.
 */
export const STRAY_EVIDENCE = 0.05

/**
 * Put the cars Find stalls left out of the rows back where the photo puts them (laying a lot out from its
 * parked cars drops a car standing alone or in a pair: straightenFoundCars). Each goes in as a box drawn
 * on it would (`addSpaceFromOutline`), but as a pending proposal for the admin to accept or reject, the
 * weakest of all so these are reviewed first. The cars nearest the stalls already outlined go first, so
 * later ones are placed against them. A car that lands in no grid cell (above row A, or with no free
 * cell near) stays out: `skipped` counts those.
 */
export function addLeftOutCars(
  draft: DraftLayout,
  viewId: string,
  cars: Outline[],
  grid: Grid,
): Grown & { added: number; skipped: number } {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view || cars.length === 0) return { draft, dx: 0, dy: 0, added: 0, skipped: cars.length }
  const outlined = Object.values(view.outlines).map((o) => centroid(o))
  const reach = (car: Outline) => {
    const [x, y] = centroid(car)
    return outlined.reduce((best, [ox, oy]) => Math.min(best, Math.hypot(ox - x, oy - y)), Infinity)
  }
  let next = draft
  let moved = grid
  let [dx, dy, added] = [0, 0, 0]
  for (const car of [...cars].sort((a, b) => reach(a) - reach(b))) {
    const placed = addSpaceFromOutline(next, viewId, car, moved)
    const shifted = shiftGrid(moved, placed.dx, placed.dy)
    const { spaceId, rect } = placed.space
    const cell = cellAt(shifted, [rect.x + rect.w / 2, rect.y + rect.h / 2])
    const box = cellRect(shifted, cell)
    const inCell =
      cell.row >= 0 && cell.col >= 0 && Math.abs(rect.x - box.x) < 0.5 && Math.abs(rect.y - box.y) < 0.5 && rect.w === box.w && rect.h === box.h
    if (!inCell) continue
    const review: OutlineReview = { source: 'proposed', status: 'pending', evidence: STRAY_EVIDENCE, newSpace: true }
    next = {
      ...placed.draft,
      viewpoints: placed.draft.viewpoints.map((v) => (v.viewId === viewId ? { ...v, outlineReview: { ...v.outlineReview, [spaceId]: review } } : v)),
    }
    moved = shifted
    dx += placed.dx
    dy += placed.dy
    added++
  }
  return { draft: next, dx, dy, added, skipped: cars.length - added }
}

/** The view's outlines still waiting for review, weakest evidence first (those without a score last). */
export function pendingProposals(
  view: DraftViewpoint,
): { spaceId: string; evidence: number | null; partial: boolean }[] {
  return Object.entries(view.outlineReview ?? {})
    .filter(([sid, r]) => r.status === 'pending' && view.outlines[sid])
    .map(([spaceId, r]) => ({
      spaceId,
      evidence: r.evidence ?? null,
      partial: touchesPhotoEdge(view.outlines[spaceId] as Point[]),
    }))
    .sort((a, b) => (a.evidence ?? Infinity) - (b.evidence ?? Infinity) || a.spaceId.localeCompare(b.spaceId))
}

/** Words for an evidence score, so the review list reads without the number. */
export function evidenceWord(evidence: number | null): string {
  if (evidence === null) return 'From the map'
  if (evidence < 0.4) return 'Weak'
  if (evidence < 0.7) return 'Fair'
  return 'Strong'
}

/** Accept proposed outlines in `viewId`: they stay as they are, reviewed. */
export function acceptProposals(draft: DraftLayout, viewId: string, spaceIds: string[]): DraftLayout {
  return {
    ...draft,
    viewpoints: draft.viewpoints.map((v) => {
      if (v.viewId !== viewId) return v
      const outlineReview = { ...v.outlineReview }
      for (const id of spaceIds) {
        const r = outlineReview[id]
        if (r?.status === 'pending') outlineReview[id] = { ...r, status: 'accepted' }
      }
      return { ...v, outlineReview }
    }),
  }
}

/**
 * Reject proposed outlines in `viewId`. A space the proposer created for its stall (`newSpace`) that has
 * no outline in any other view is not a real space, so it goes too; it was never published, since its
 * pending outline blocked publishing. Every other space keeps everything but this outline.
 */
export function rejectProposals(
  draft: DraftLayout,
  viewId: string,
  spaceIds: string[],
): { draft: DraftLayout; removedSpaces: number } {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) return { draft, removedSpaces: 0 }
  // Find stalls skips these from now on, so a rejected stall doesn't come back on the next run.
  const rejected = spaceIds
    .filter((id) => view.outlineReview?.[id]?.source === 'proposed' && view.outlineReview[id].status === 'pending')
    .map((id) => view.outlines[id])
    .filter((o): o is Outline => o !== undefined)
  let next = draft
  let removedSpaces = 0
  for (const id of spaceIds) {
    const review = view.outlineReview?.[id]
    const elsewhere = next.viewpoints.some((v) => v.viewId !== viewId && v.outlines[id])
    if (review?.status === 'pending' && review.newSpace && !elsewhere) {
      next = deleteSpace(next, id)
      removedSpaces++
      continue
    }
    next = {
      ...next,
      viewpoints: next.viewpoints.map((v) => {
        if (v.viewId !== viewId) return v
        const { [id]: _o, ...outlines } = v.outlines
        const { [id]: _r, ...outlineReview } = v.outlineReview ?? {}
        return { ...v, outlines, outlineReview }
      }),
    }
  }
  if (rejected.length > 0) {
    next = {
      ...next,
      viewpoints: next.viewpoints.map((v) =>
        v.viewId === viewId ? { ...v, rejectedStalls: [...(v.rejectedStalls ?? []), ...rejected].slice(-MAX_REJECTED) } : v,
      ),
    }
  }
  return { draft: next, removedSpaces }
}

/** Forget the stalls rejected in a view, so Find stalls proposes them again. */
export function forgetRejected(draft: DraftLayout, viewId: string): DraftLayout {
  return {
    ...draft,
    viewpoints: draft.viewpoints.map((v) => (v.viewId === viewId ? { ...v, rejectedStalls: [] } : v)),
  }
}

export { touchesPhotoEdge }
