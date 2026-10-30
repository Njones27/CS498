import { MIN_SIDE, clearOf, medianSize } from './schematic/geometry'
import { addSpace, addSpaceAt, addSpacesAt, fitSchematic, updateSpace, type Grown } from './schematic/edits'
import { applyLabels, cellAt, cellLabel, cellRect, cellTaken, labelDigits, relabelMoved, type Cell, type Grid } from './schematic/grid'
import { photoCell, placeFromPhoto } from './photoGrid'
import { isValidQuad, orderClockwise } from './photo/geom'
import type { DraftLayout, DraftRect, DraftSpace, DraftViewpoint, Outline, Point } from './types'

// Keeps the photo and the schematic in step. Each viewpoint gets a projective map between its photo
// (fractions 0..1) and the schematic (units), fitted from the spaces it already has outlined, so a space
// drawn on the photo lands in the right spot on the schematic, and one added on the schematic gets a
// proposed outline on the photo. Pure: every edit returns a new DraftLayout.

/** A 3x3 projective map, row-major, applied to [x, y, 1]. */
export type Mat3 = number[]

/** The fewest points (and accepted outlines) a fit needs: four non-collinear points pin down a homography. */
export const MIN_MATCHES = 4

export function applyMat(m: Mat3, [x, y]: Point): Point | null {
  const w = m[6] * x + m[7] * y + m[8]
  if (!(w > 1e-9)) return null // behind the camera's horizon: no sensible point
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = []
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c])
  return out
}

export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const adj = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]
  return adj.map((v) => v / det)
}

/** Solve A x = b by Gaussian elimination with partial pivoting; null when A is (nearly) singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    if (Math.abs(M[pivot][col]) < 1e-9) return null
    ;[M[col], M[pivot]] = [M[pivot], M[col]]
    for (let r = col + 1; r < n; r++) {
      const k = M[r][col] / M[col][col]
      for (let c = col; c <= n; c++) M[r][c] -= k * M[col][c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c]
    x[r] = s / M[r][r]
  }
  return x
}

/** Move the points' centroid to the origin and scale their mean distance to sqrt(2) (Hartley), for a well-conditioned fit. */
function normalizer(points: Point[]): Mat3 | null {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length
  const mean = points.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / points.length
  if (!(mean > 1e-12)) return null
  const k = Math.SQRT2 / mean
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1]
}

/**
 * How far the points are from lying on one line: the smaller over the larger spread of their covariance
 * (0 for a line, 1 for a round cloud). Hand-drawn outlines of one row are never exactly on a line, so a
 * cut-off is needed rather than a singular solve.
 */
function flatness(points: Point[]): number {
  const [cx, cy] = centroid(points)
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const [x, y] of points) {
    sxx += (x - cx) ** 2
    syy += (y - cy) ** 2
    sxy += (x - cx) * (y - cy)
  }
  const mid = (sxx + syy) / 2
  const r = Math.hypot((sxx - syy) / 2, sxy)
  return mid + r > 0 ? (mid - r) / (mid + r) : 0
}

/** Below this, a point set counts as one line (spread ratio 1:30). */
const MIN_FLATNESS = 1e-3
/** Largest RMS miss of a fit on its own points, in normalized units (their mean spread is sqrt 2). */
const MAX_RESIDUAL = 0.25

/**
 * Least-squares map from `src` to `dst` points: a homography (perspective) when the points support one,
 * else an affine map. Null for fewer than MIN_MATCHES points, either set (nearly) on one line, or no fit
 * that lands near its own points.
 */
export function fitTransform(src: Point[], dst: Point[]): Mat3 | null {
  if (src.length < MIN_MATCHES || src.length !== dst.length) return null
  if (flatness(src) < MIN_FLATNESS || flatness(dst) < MIN_FLATNESS) return null
  const Ts = normalizer(src)
  const Td = normalizer(dst)
  if (!Ts || !Td) return null
  const s = src.map((p) => applyMat(Ts, p)!)
  const d = dst.map((p) => applyMat(Td, p)!)
  const TdInv = invert(Td)!
  // Four points pin a homography exactly, so its own residual says nothing; it needs a fifth to be checked.
  for (const projective of src.length > MIN_MATCHES ? [true, false] : [false]) {
    const n = projective ? 8 : 6
    const AtA = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    const Atb = new Array<number>(n).fill(0)
    const addRow = (row: number[], rhs: number) => {
      for (let i = 0; i < n; i++) {
        Atb[i] += row[i] * rhs
        for (let j = 0; j < n; j++) AtA[i][j] += row[i] * row[j]
      }
    }
    s.forEach(([x, y], i) => {
      const [u, v] = d[i]
      addRow(projective ? [x, y, 1, 0, 0, 0, -x * u, -y * u] : [x, y, 1, 0, 0, 0], u)
      addRow(projective ? [0, 0, 0, x, y, 1, -x * v, -y * v] : [0, 0, 0, x, y, 1], v)
    })
    const h = solve(AtA, Atb)
    if (!h) continue
    const hn: Mat3 = projective ? [...h, 1] : [...h, 0, 0, 1]
    // A perspective fit must keep every source point in front of the horizon and land near its own
    // points; one that doesn't (noisy outlines) falls back to the affine one.
    let sq = 0
    const fits = s.every((p, i) => {
      const q = applyMat(hn, p)
      if (!q) return false
      sq += (q[0] - d[i][0]) ** 2 + (q[1] - d[i][1]) ** 2
      return true
    })
    if (fits && Math.sqrt(sq / s.length) <= MAX_RESIDUAL) return multiply(TdInv, multiply(hn, Ts))
  }
  return null
}

const centroid = (pts: Point[]): Point => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
]
const rectCenter = (r: DraftRect): Point => [r.x + r.w / 2, r.y + r.h / 2]

/**
 * Outlines that stand as ground truth for the fit: drawn by an admin (or seeded) on active spaces.
 * Proposals are left out even once accepted: they came from a fit (or a detector), so they add nothing,
 * and one pulled onto the photo edge would bend the map.
 */
function anchorOutlines(draft: DraftLayout, view: DraftViewpoint): [DraftSpace, Outline][] {
  return draft.spaces.flatMap((s): [DraftSpace, Outline][] => {
    const outline = view.outlines[s.spaceId]
    if (s.retired || !outline || view.outlineReview?.[s.spaceId]?.source === 'proposed') return []
    return [[s, outline]]
  })
}

const rectCorners = (r: DraftRect): Point[] => [
  [r.x, r.y],
  [r.x + r.w, r.y],
  [r.x + r.w, r.y + r.h],
  [r.x, r.y + r.h],
]

/**
 * Photo (fractions) -> schematic (units) for one viewpoint. Fitted on outline centres against rect
 * centres, which holds up however the photo is turned. A single row of spaces puts the centres on one
 * line, so then it fits corners (outlines run clockwise from top-left, like rect corners) instead.
 */
export function photoToSchematic(draft: DraftLayout, view: DraftViewpoint): Mat3 | null {
  const pairs = anchorOutlines(draft, view)
  if (pairs.length < MIN_MATCHES) return null // too few spaces to go by, even with four corners each
  return (
    fitTransform(
      pairs.map(([, o]) => centroid(o)),
      pairs.map(([s]) => rectCenter(s.rect)),
    ) ??
    fitTransform(
      pairs.flatMap(([, o]) => o),
      pairs.flatMap(([s]) => rectCorners(s.rect)),
    )
  )
}

/** The schematic rectangle covering a photo outline, or null when it maps nowhere sensible. */
export function outlineToRect(m: Mat3, outline: Outline): DraftRect | null {
  const pts = outline.map((p) => applyMat(m, p))
  if (pts.some((p) => p === null || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null
  const xs = pts.map((p) => p![0])
  const ys = pts.map((p) => p![1])
  const x = Math.round(Math.min(...xs))
  const y = Math.round(Math.min(...ys))
  return {
    x,
    y,
    w: Math.max(MIN_SIDE, Math.round(Math.max(...xs)) - x),
    h: Math.max(MIN_SIDE, Math.round(Math.max(...ys)) - y),
  }
}

/**
 * The photo outline of a schematic rectangle (`toPhoto` maps schematic -> photo). Corners past the
 * photo edge are pulled onto it; null when the space's middle is off the photo, or when pulling folds
 * the outline so publishing would reject it (bad_polygon).
 */
export function rectToOutline(toPhoto: Mat3, rect: DraftRect): Outline | null {
  const center = applyMat(toPhoto, rectCenter(rect))
  if (!center || center[0] < 0 || center[0] > 1 || center[1] < 0 || center[1] > 1) return null
  const pts = rectCorners(rect).map((c) => applyMat(toPhoto, c))
  if (pts.some((p) => p === null)) return null
  const clamped = orderClockwise(
    pts.map((p): Point => [
      Number(Math.min(1, Math.max(0, p![0])).toFixed(4)),
      Number(Math.min(1, Math.max(0, p![1])).toFixed(4)),
    ]),
  )
  // Pulling corners onto the edge can fold two together; publishing would reject that as bad_polygon.
  return isValidQuad(clamped) ? clamped : null
}

/** Where `spaceId` would sit on `view`'s photo, projected from its schematic rect; null without a fit. */
export function suggestOutline(draft: DraftLayout, view: DraftViewpoint, spaceId: string): Outline | null {
  const space = draft.spaces.find((s) => s.spaceId === spaceId)
  if (!space || !view.referenceImage) return null
  const toPhoto = schematicToPhoto(draft, view)
  return toPhoto ? rectToOutline(toPhoto, space.rect) : null
}

/**
 * Proposed outlines (pending review) for `spaceIds` on every photo they don't have an outline in yet,
 * projected from their schematic rects. Views without a photo or a fit are left alone.
 */
export function proposeOutlines(draft: DraftLayout, spaceIds: string[]): DraftLayout {
  let changed = false
  const viewpoints = draft.viewpoints.map((v) => {
    const toPhoto = v.referenceImage ? schematicToPhoto(draft, v) : null
    if (!toPhoto) return v
    const outlines = { ...v.outlines }
    const outlineReview = { ...v.outlineReview }
    let touched = false
    for (const id of spaceIds) {
      const space = draft.spaces.find((s) => s.spaceId === id)
      if (!space || space.retired || outlines[id]) continue
      const outline = rectToOutline(toPhoto, space.rect)
      if (!outline) continue
      outlines[id] = outline
      outlineReview[id] = { source: 'proposed', status: 'pending' }
      touched = true
    }
    if (!touched) return v
    changed = true
    return { ...v, outlines, outlineReview }
  })
  return changed ? { ...draft, viewpoints } : draft
}

/** The schematic -> photo map for one viewpoint, or null without a fit. */
function schematicToPhoto(draft: DraftLayout, view: DraftViewpoint): Mat3 | null {
  const m = photoToSchematic(draft, view)
  return m && invert(m)
}

/**
 * Carries a point along as rect `a` becomes rect `b`: a point on an edge moves with that edge, one
 * between edges moves in proportion, and one past an edge moves with that edge. So moving only the
 * bottom edge leaves everything at the top where it was.
 */
const edgeCarry =
  (a: DraftRect, b: DraftRect) =>
  ([x, y]: Point): Point => {
    const u = Math.min(1, Math.max(0, (x - a.x) / a.w))
    const v = Math.min(1, Math.max(0, (y - a.y) / a.h))
    const dl = b.x - a.x
    const dr = b.x + b.w - (a.x + a.w)
    const dt = b.y - a.y
    const db = b.y + b.h - (a.y + a.h)
    return [x + dl * (1 - u) + dr * u, y + dt * (1 - v) + db * v]
  }

const sameRect = (a: DraftRect, b: DraftRect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** An outline's corners pulled onto the photo and rounded as stored; null if that leaves no valid four-sided shape. */
function onPhoto(pts: (Point | null)[]): Outline | null {
  if (pts.some((p) => p === null || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null
  const out = pts.map((p): Point => [
    Number(Math.min(1, Math.max(0, p![0])).toFixed(4)),
    Number(Math.min(1, Math.max(0, p![1])).toFixed(4)),
  ])
  const [cx, cy] = centroid(pts as Point[])
  return cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1 && isValidQuad(out) ? out : null
}

/**
 * After `spaceIds` moved or resized on the schematic (`before` -> `after`), their outlines on the photos
 * move and resize the same way: each corner moves with the rect's edges (edgeCarry), carried through the
 * view's photo <-> schematic map (fitted on `before`). An outline that would leave the photo or fold
 * stays where it was, except a proposal still waiting for review, which is dropped. `skipViewId` is left
 * alone (the view the change came from).
 */
export function followRects(before: DraftLayout, after: DraftLayout, spaceIds: string[], skipViewId?: string): DraftLayout {
  let changed = false
  const viewpoints = after.viewpoints.map((v) => {
    const vBefore = before.viewpoints.find((b) => b.viewId === v.viewId)
    if (v.viewId === skipViewId || !vBefore) return v
    const ids = spaceIds.filter((id) => v.outlines[id])
    const toSchematic = ids.length ? photoToSchematic(before, vBefore) : null
    const toPhoto = toSchematic && invert(toSchematic)
    if (!toSchematic || !toPhoto) return v
    const outlines = { ...v.outlines }
    const outlineReview = { ...v.outlineReview }
    let touched = false
    for (const id of ids) {
      const was = before.spaces.find((s) => s.spaceId === id)
      const now = after.spaces.find((s) => s.spaceId === id)
      if (!was || !now || now.retired || sameRect(was.rect, now.rect)) continue
      const carry = edgeCarry(was.rect, now.rect)
      const moved = onPhoto(
        v.outlines[id].map((p) => {
          const q = applyMat(toSchematic, p)
          return q && applyMat(toPhoto, carry(q))
        }),
      )
      if (moved) {
        outlines[id] = moved
      } else if (v.outlineReview?.[id]?.status === 'pending') {
        delete outlines[id]
        delete outlineReview[id]
      } else {
        continue
      }
      touched = true
    }
    if (!touched) return v
    changed = true
    return { ...v, outlines, outlineReview }
  })
  return changed ? { ...after, viewpoints } : after
}

/** Width and height of an outline's bounding box on the photo (fractions). */
function photoSize(outline: Outline): [number, number] {
  const xs = outline.map((p) => p[0])
  const ys = outline.map((p) => p[1])
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
}

/** The bounding box, in schematic units, of a photo outline. */
function mappedBox(m: Mat3, outline: Outline): DraftRect | null {
  const pts = outline.map((p) => applyMat(m, p))
  if (pts.some((p) => p === null || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null
  const xs = pts.map((p) => p![0])
  const ys = pts.map((p) => p![1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const w = Math.max(...xs) - x
  const h = Math.max(...ys) - y
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * After `spaceId`'s outline in `viewId` was moved or reshaped on the photo (`before` -> `after`), its
 * schematic rect moves and resizes the same way, through the view's map; then its outlines in the other
 * views follow the rect. With a `grid`, landing in another cell renames the space for that cell; with
 * `snap` too, the rect only changes when the outline moved it into another cell, and then fills it.
 * `note` says what was renamed.
 * A first outline moves nothing: it says where the space is on the photo, not that it moved.
 */
export function followOutline(
  before: DraftLayout,
  after: DraftLayout,
  viewId: string,
  spaceId: string,
  grid: Grid | null,
  snap = true,
): Grown & { note?: string } {
  const unchanged = { draft: after, dx: 0, dy: 0 }
  const vBefore = before.viewpoints.find((v) => v.viewId === viewId)
  const vAfter = after.viewpoints.find((v) => v.viewId === viewId)
  const space = after.spaces.find((s) => s.spaceId === spaceId)
  const old = vBefore?.outlines[spaceId]
  const now = vAfter?.outlines[spaceId]
  if (!vBefore || !old || !now || !space || space.retired) return unchanged
  const m = photoToSchematic(before, vBefore)
  const b0 = m && mappedBox(m, old)
  const b1 = m && mappedBox(m, now)
  if (!b0 || !b1) return unchanged
  // Move or reshape is decided on the photo itself: through a perspective map, a plain move of an
  // outline changes its mapped size a little, which must not count as a resize.
  const [w0, h0] = photoSize(old)
  const [w1, h1] = photoSize(now)
  const isMove = Math.abs(w1 - w0) <= 0.02 * w0 + 1e-4 && Math.abs(h1 - h0) <= 0.02 * h0 + 1e-4
  const { x, y, w, h } = space.rect
  let rect: DraftRect
  if (isMove) {
    // The rect keeps its size; its middle moves as far as the outline's middle did.
    const dx = b1.x + b1.w / 2 - (b0.x + b0.w / 2)
    const dy = b1.y + b1.h / 2 - (b0.y + b0.h / 2)
    rect = { x: r2(x + dx), y: r2(y + dy), w, h }
  } else {
    // A reshape: each edge of the rect moves as far as the same edge of the outline's box did.
    const left = x + (b1.x - b0.x)
    const top = y + (b1.y - b0.y)
    const right = x + w + (b1.x + b1.w - (b0.x + b0.w))
    const bottom = y + h + (b1.y + b1.h - (b0.y + b0.h))
    rect = { x: r2(left), y: r2(top), w: r2(Math.max(MIN_SIDE, right - left)), h: r2(Math.max(MIN_SIDE, bottom - top)) }
  }
  if (!plausibleRect(after, rect)) return unchanged
  let labels = new Map<string, string>()
  let note: string | undefined
  if (grid && snap && !isMove) return unchanged // the grid sets the box size while snapping
  if (grid && isMove && vAfter) {
    // The cell is read off the photo (photoCell) when it can be: the schematic may draw a row stretched
    // or numbered from the wrong column. Otherwise it is where the rect lands on the schematic.
    const photoFrom = photoCell(before, vBefore, old, spaceId)
    const photoTo = photoCell(after, vAfter, now, spaceId)
    const [from, to] =
      photoFrom && photoTo ? [photoFrom, photoTo] : [cellAt(grid, rectCenter(space.rect)), cellAt(grid, rectCenter(rect))]
    const changedCell = to.row !== from.row || to.col !== from.col
    if (snap) {
      if (!changedCell) return unchanged
      // Never stack two spaces in one cell: the schematic stays, the outline change still stands.
      if (cellTaken(grid, after.spaces, to, null, spaceId)) {
        return { ...unchanged, note: `The schematic cell there already has a space; ${space.label} stays where it is` }
      }
      rect = cellRect(grid, to)
    }
    // Landing in another cell renames the space for it (row letter, column number).
    if (changedCell) ({ labels, note } = relabelMoved(grid, after.spaces, spaceId, to))
  }
  if (sameRect(rect, space.rect) && labels.size === 0) return unchanged
  const moved = applyLabels(updateSpace(after, spaceId, { rect }), labels)
  return { ...fitSchematic(followRects(after, moved, [spaceId], viewId)), note }
}

/** Remove the proposals still waiting for review for `spaceIds` (a retired space should not block publishing). */
export function dropPendingProposals(draft: DraftLayout, spaceIds: string[]): DraftLayout {
  let changed = false
  const viewpoints = draft.viewpoints.map((v) => {
    const ids = spaceIds.filter((id) => v.outlineReview?.[id]?.status === 'pending')
    if (ids.length === 0) return v
    changed = true
    const outlines = { ...v.outlines }
    const outlineReview = { ...v.outlineReview }
    for (const id of ids) {
      delete outlines[id]
      delete outlineReview[id]
    }
    return { ...v, outlines, outlineReview }
  })
  return changed ? { ...draft, viewpoints } : draft
}

/** The space whose outline in `view` has its centre nearest `point`. */
function nearestOutlined(draft: DraftLayout, view: DraftViewpoint, point: Point): DraftSpace | null {
  let best: DraftSpace | null = null
  let dist = Infinity
  for (const [s, o] of anchorOutlines(draft, view)) {
    const c = centroid(o)
    const d = Math.hypot(c[0] - point[0], c[1] - point[1])
    if (d < dist) [dist, best] = [d, s]
  }
  return best
}

/**
 * Whether a rect mapped from the photo is believable: no bigger than a few spaces, and within a few rows
 * of the map. A box drawn where the fit extrapolates badly (towards the horizon) maps far away and huge;
 * that would grow the map without bound.
 */
function plausibleRect(draft: DraftLayout, r: DraftRect): boolean {
  const size = medianSize(draft.spaces.filter((s) => !s.retired).map((s) => s.rect))
  const { width, height } = draft.schematic
  if (size && (r.w > 4 * size.w || r.h > 4 * size.h)) return false
  // Room for a few new rows or columns past any edge, but not a jump that would double the map.
  const mx = Math.max(0.25 * width, 3 * (size?.w ?? 0))
  const my = Math.max(0.25 * height, 3 * (size?.h ?? 0))
  return r.x > -mx && r.y > -my && r.x + r.w < width + mx && r.y + r.h < height + my
}

/**
 * A new space drawn on `viewId`'s photo: placed on the schematic where the photo maps to (else right of
 * the nearest outlined space's row), outlined in that view, and proposed in the other views.
 */
export function addSpaceFromOutline(
  draft: DraftLayout,
  viewId: string,
  outline: Outline,
  grid: Grid | null = null,
): Grown & { space: DraftSpace; note?: string } {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) throw new Error(`No viewpoint ${viewId}`)
  // With a grid, the photo itself says which cell the box is in (its row from the outlines beside it,
  // its column from the rows above and below); the space goes there and is named for it.
  const fromPhoto = grid && photoCell(draft, view, outline)
  if (grid && fromPhoto && cellLabel(fromPhoto)) {
    const added = addSpaceAt(draft, cellRect(grid, fromPhoto))
    const id = added.space.spaceId
    const outlined = withOutline(added.draft, viewId, id, outline)
    const placed = placeFromPhoto(outlined, viewId, id, grid)
    const next = proposeOutlines(placed.draft, [id])
    return {
      draft: next,
      dx: added.dx + placed.dx,
      dy: added.dy + placed.dy,
      space: next.spaces.find((s) => s.spaceId === id)!,
      note: placed.note,
    }
  }
  const m = photoToSchematic(draft, view)
  const mapped = m && outlineToRect(m, outline)
  const rect = mapped && plausibleRect(draft, mapped) ? mapped : null
  // Snapping on: the space fills the free cell it lands in and is named for it.
  const cell = grid && rect ? cellAt(grid, rectCenter(rect)) : null
  const cellName = cell && cellLabel(cell, labelDigits(draft.spaces))
  const inCell = grid && cell && cellName && !cellTaken(grid, draft.spaces, cell, cellName)
  const added = inCell
    ? addSpaceAt(draft, cellRect(grid, cell), cellName)
    : rect
      ? addSpaceAt(draft, clearOf(rect, draft.spaces))
      : addSpace(draft, nearestOutlined(draft, view, centroid(outline))?.spaceId ?? null)
  const id = added.space.spaceId
  const next = proposeOutlines(withOutline(added.draft, viewId, id, outline), [id])
  return { draft: next, dx: added.dx, dy: added.dy, space: next.spaces.find((s) => s.spaceId === id)! }
}

/** `draft` with `outline` drawn (accepted) for `spaceId` in `viewId`. */
function withOutline(draft: DraftLayout, viewId: string, spaceId: string, outline: Outline): DraftLayout {
  return {
    ...draft,
    viewpoints: draft.viewpoints.map((v) =>
      v.viewId === viewId
        ? {
            ...v,
            outlines: { ...v.outlines, [spaceId]: outline },
            outlineReview: { ...v.outlineReview, [spaceId]: { source: 'drawn' as const, status: 'accepted' as const } },
          }
        : v,
    ),
  }
}

/** A space drawn on the schematic at `rect`, with proposed outlines on every photo it lands on. */
export function addSpaceOnSchematic(draft: DraftLayout, rect: DraftRect): Grown & { space: DraftSpace } {
  const added = addSpaceAt(draft, rect)
  return { ...added, draft: proposeOutlines(added.draft, [added.space.spaceId]) }
}

/**
 * A box drawn on the schematic with snapping on: one space per free cell it covers, named for the cell,
 * each with proposed outlines on the photos. Cells already holding a space (or whose label is used), and
 * cells outside the lettered rows, are skipped.
 */
export function addSpacesInCells(draft: DraftLayout, grid: Grid, cells: Cell[]): Grown & { spaces: DraftSpace[] } {
  const items: { rect: DraftRect; label: string }[] = []
  const digits = labelDigits(draft.spaces)
  for (const cell of cells) {
    const label = cellLabel(cell, digits)
    const placed = [...draft.spaces, ...items.map((it, i) => ({ spaceId: `new${i}`, label: it.label, type: 'STANDARD' as const, rect: it.rect, retired: false }))]
    if (label && !cellTaken(grid, placed, cell, label)) items.push({ rect: cellRect(grid, cell), label })
  }
  if (items.length === 0) return { draft, dx: 0, dy: 0, spaces: [] }
  const added = addSpacesAt(draft, items)
  return { ...added, draft: proposeOutlines(added.draft, added.spaces.map((s) => s.spaceId)) }
}

/** After `spaceIds` moved or resized (`before` -> `after`): their outlines follow, and the map grows to hold them. */
export function afterRectChange(before: DraftLayout, after: DraftLayout, spaceIds: string[]): Grown {
  return fitSchematic(followRects(before, after, spaceIds))
}
