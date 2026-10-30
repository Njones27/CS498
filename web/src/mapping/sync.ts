import { MIN_SIDE, clearOf, medianSize } from './schematic/geometry'
import { addSpace, addSpaceAt, fitSchematic, type Grown } from './schematic/edits'
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
  const m = photoToSchematic(draft, view)
  const toPhoto = m && invert(m)
  return toPhoto ? rectToOutline(toPhoto, space.rect) : null
}

/**
 * Proposed outlines (pending review) for `spaceIds` on every photo they don't have an outline in yet,
 * projected from their schematic rects. Views without a photo or a fit are left alone.
 */
export function proposeOutlines(draft: DraftLayout, spaceIds: string[]): DraftLayout {
  let changed = false
  const viewpoints = draft.viewpoints.map((v) => {
    if (!v.referenceImage) return v
    const m = photoToSchematic(draft, v)
    const toPhoto = m && invert(m)
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

const sameOutline = (a: Outline, b: Outline) =>
  a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) <= 2e-4 && Math.abs(p[1] - b[i][1]) <= 2e-4)

/**
 * After `spaceIds` moved or resized on the schematic (`before` -> `after`), move the proposals this
 * editor made for them and that still wait for review. A proposal is moved only while it is exactly the
 * projection of the old rect, so a detector's proposal or one an admin dragged stays put; one that no
 * longer lands on the photo is dropped. Accepted outlines are the admin's and never move.
 */
export function reprojectPending(before: DraftLayout, after: DraftLayout, spaceIds: string[]): DraftLayout {
  let changed = false
  const viewpoints = after.viewpoints.map((v) => {
    const ids = spaceIds.filter((id) => v.outlineReview?.[id]?.status === 'pending' && v.outlineReview[id].source === 'proposed')
    const vBefore = before.viewpoints.find((b) => b.viewId === v.viewId)
    const oldMap = vBefore && schematicToPhoto(before, vBefore)
    const newMap = schematicToPhoto(after, v)
    if (ids.length === 0 || !oldMap || !newMap) return v
    const outlines = { ...v.outlines }
    const outlineReview = { ...v.outlineReview }
    let touched = false
    for (const id of ids) {
      const was = before.spaces.find((s) => s.spaceId === id)
      const now = after.spaces.find((s) => s.spaceId === id)
      const projected = was && rectToOutline(oldMap, was.rect)
      if (!now || !projected || !sameOutline(projected, v.outlines[id])) continue
      const outline = now.retired ? null : rectToOutline(newMap, now.rect)
      if (outline) {
        outlines[id] = outline
      } else {
        delete outlines[id]
        delete outlineReview[id]
      }
      touched = true
    }
    if (!touched) return v
    changed = true
    return { ...v, outlines, outlineReview }
  })
  return changed ? { ...after, viewpoints } : after
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
 * Whether a rect mapped from the photo is believable: no bigger than a few spaces, and within a few rows of
 * the map. A box
 * drawn where the fit extrapolates badly (towards the horizon) maps far away and huge; that would grow
 * the map without bound.
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
): { draft: DraftLayout; space: DraftSpace } {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) throw new Error(`No viewpoint ${viewId}`)
  const m = photoToSchematic(draft, view)
  const mapped = m && outlineToRect(m, outline)
  const rect = mapped && plausibleRect(draft, mapped) ? mapped : null
  const added = rect
    ? addSpaceAt(draft, clearOf(rect, draft.spaces))
    : addSpace(draft, nearestOutlined(draft, view, centroid(outline))?.spaceId ?? null)
  const id = added.space.spaceId
  const viewpoints = added.draft.viewpoints.map((v) =>
    v.viewId === viewId
      ? {
          ...v,
          outlines: { ...v.outlines, [id]: outline },
          outlineReview: { ...v.outlineReview, [id]: { source: 'drawn' as const, status: 'accepted' as const } },
        }
      : v,
  )
  const next = proposeOutlines({ ...added.draft, viewpoints }, [id])
  return { draft: next, space: next.spaces.find((s) => s.spaceId === id)! }
}

/** A space drawn on the schematic at `rect`, with proposed outlines on every photo it lands on. */
export function addSpaceOnSchematic(draft: DraftLayout, rect: DraftRect): Grown & { space: DraftSpace } {
  const added = addSpaceAt(draft, rect)
  return { ...added, draft: proposeOutlines(added.draft, [added.space.spaceId]) }
}

/** After `spaceIds` moved or resized (`before` -> `after`): their proposals follow, and the map grows to hold them. */
export function afterRectChange(before: DraftLayout, after: DraftLayout, spaceIds: string[]): Grown {
  return fitSchematic(reprojectPending(before, after, spaceIds))
}
