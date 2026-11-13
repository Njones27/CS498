import { newSpaceId } from './schematic/edits'
import { area, clipPolygon } from './proposals'
import { MARGIN } from './schematic/geometry'
import { formatLabel, parseLabel } from './schematic/labels'
import type { DraftLayout, DraftRect, DraftSpace, Outline, OutlineReview, Point } from './types'

// Straighten from photo: a top-down, axis-aligned schematic from the stalls outlined on one photo, for a
// camera at an angle (PKLot UFPR04) whose outlines are perspective quads at odd angles. Pure.
//
// 1. Ground plane: a homography fitted so every outline becomes the same parallelogram (stalls are all
//    one size on the ground) gives the ground's vanishing line. Identical stalls fix the ground only up
//    to a stretch and a shear, so the rest comes from the camera: square pixels, centred, focal length f.
//    With f, the vanishing line gives the ground's tilt, and the photo is turned to look straight down.
// 2. Rows: neighbouring stall centres run along their row (stalls sit closer side by side than back to
//    back), so the commonest nearest-neighbour direction is the lot's row direction; stalls linked along
//    it form a row, back-to-back pairs one double row, split into its two rows by which side they sit.
//    The two rows of a double row share their dividers, so they share one lean.
//    f is the one (around a usual lens) that keeps the rows whole and their leans agreeing.
// 3. Lean: the angle between a stall's sides and its row's own line, snapped to the parking angles lots
//    are built at (multiples of 15 degrees). A stall outlined square to its row is a square stall. With
//    paint from Find stalls, the paint decides: a parked car's outline leans towards the camera (the
//    car has a height), the paint lies flat on the ground (`paintLeans`).
// 4. Grid: rows level, top to bottom A, B, C ..., back to back or with the drive between them; numbers
//    run along each row; every stall the same box, so the result sits on the schematic grid (label =
//    cell). North turns with the map (the rotation that best maps the old map onto the new one).
// 5. Gaps: a stall missing inside a row (up to MAX_GAP) is found: a new space in its cell, with an outline
//    projected back onto the photo for the admin to accept or reject, like the layout proposer's.

/** Fewest outlines in the view that pin down the ground plane well. */
export const MIN_STRAIGHTEN = 6

/** Most a row may wander from the lot's row direction (degrees) and still be one row. */
const ROW_TILT = 40

/** Stalls further apart than this many typical neighbour spacings are not linked into one row. */
const LINK_REACH = 2.2

/** Rows closer than this many stall depths apart (beyond back to back) are back to back: a drive aisle
 * is at least a stall deep, and the fit leaves some slack. */
const BACK_TO_BACK = 0.75

/** Stall depth over width on the map, held to real stalls' range. */
const MIN_ASPECT = 1
const MAX_ASPECT = 3

/** Most stalls in a row's gap that are proposed (a longer gap is more likely a drive or an island). */
const MAX_GAP = 4

/** Evidence given to a stall found in a row's gap (weaker than a painted stall's; see proposer). */
const GAP_EVIDENCE = 0.3

/** Leans snap to the angles lots are built at: 90, 75, 60, 45 and 30 degrees to the row. */
const LEAN_STEP = 15
const MAX_LEAN = 60

/** Focal lengths tried, as a share of the photo's width; a usual CCTV lens is about 1.3. */
const FOCAL_TRIES = Array.from({ length: 15 }, (_, i) => 0.6 + 0.1 * i)
const FOCAL_USUAL = 1.3

type Mat3 = number[] // row-major 3x3 with [8] = 1

/** Paint pieces this far from square to their row or more (degrees) are a lean; nearer is along it. */
const ALONG_ROW = 25
/** Fewest paint pieces that settle the lot's lean, or a row's own. */
const MIN_PAINT = 6
/** Share of a row's paint (by length) that must agree for the row to depart from the lot's angle. */
const CLEAR_PAINT = 0.7

/**
 * The lot's lean read from paint lying on the ground next to its stalls: each piece, seen from above,
 * belongs to the row of the nearest stall, and leans from square to that row by some angle. Pieces
 * running along the row (row lines, kerbs) are left out. The commonest lean of all the paint (weighed
 * by length, snapped to LEAN_STEP) is the lot's; a double row takes it, leaning the way most of its own
 * paint does, unless its own paint clearly says another angle (CLEAR_PAINT of it, MIN_PAINT pieces or
 * more). Rows are left as they are when the lot's paint is too thin to say.
 */
function paintLeans<T>(
  rows: Row<T>[],
  stalls: GroundStall<T>[],
  paint: [number, number, number, number][],
  camera: ReturnType<typeof groundView>,
  image: { width: number; height: number },
): Map<Row<T>, PaintSupport> {
  const support = new Map<Row<T>, PaintSupport>()
  const rowOf = new Map<GroundStall<T>, Row<T>>()
  rows.forEach((r) => r.stalls.forEach((t) => rowOf.set(t, r)))
  const votes = new Map<number, number>()
  const byRow = new Map<Row<T>, { lean: number; weight: number }[]>()
  for (const [x1, y1, x2, y2] of paint) {
    const a = camera.toGround([x1 * image.width, y1 * image.height])
    const b = camera.toGround([x2 * image.width, y2 * image.height])
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const near = stalls.reduce((p, q) => (len(sub(q.centre, mid)) < len(sub(p.centre, mid)) ? q : p))
    const row = rowOf.get(near)
    if (!row) continue
    const side: Point = [-row.dir[1], row.dir[0]]
    let d = unit(sub(b, a))
    if (dot(d, side) < 0) d = [-d[0], -d[1]]
    const lean = (-Math.atan2(dot(d, row.dir), dot(d, side)) * 180) / Math.PI
    if (Math.abs(lean) > 90 - ALONG_ROW) continue
    const weight = len(sub(b, a))
    const step = Math.round(Math.abs(lean) / LEAN_STEP) * LEAN_STEP
    votes.set(step, (votes.get(step) ?? 0) + weight)
    byRow.set(row, [...(byRow.get(row) ?? []), { lean, weight }])
  }
  const pieces = [...byRow.values()].reduce((t, v) => t + v.length, 0)
  if (pieces < MIN_PAINT) return support
  const [lot] = [...votes].reduce((a, b) => (b[1] > a[1] ? b : a))
  // The two rows of a double row (they share their line, `dir`) share their dividers, so their paint
  // votes together. A double row with paint enough of its own leans the way that paint does; one
  // with too little follows the lot.
  for (const r of rows) {
    const own = rows.filter((o) => o.dir === r.dir).flatMap((o) => byRow.get(o) ?? [])
    const tally = new Map<number, number>()
    for (const v of own) {
      const step = Math.round(Math.abs(v.lean) / LEAN_STEP) * LEAN_STEP
      tally.set(step, (tally.get(step) ?? 0) + v.weight)
    }
    const ownLean = tally.size > 0 ? [...tally].reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null
    const total = own.reduce((t, v) => t + v.weight, 0)
    const shareAt = (angle: number) =>
      total > 0 ? own.filter((v) => Math.abs(Math.abs(v.lean) - angle) <= LEAN_STEP / 2).reduce((t, v) => t + v.weight, 0) / total : 0
    // A lot is built at one parking angle: a row departs from it only when its own paint clearly
    // says so (car edges and kerbs make some paint point anywhere).
    const departs = own.length >= MIN_PAINT && ownLean !== null && ownLean !== lot && shareAt(ownLean) >= CLEAR_PAINT
    const angle = departs ? ownLean : lot
    const at = own.filter((v) => Math.abs(Math.abs(v.lean) - angle) <= LEAN_STEP / 2)
    const way = at.reduce((t, v) => t + Math.sign(v.lean) * v.weight, 0)
    r.lean = angle * (way !== 0 ? Math.sign(way) : Math.sign(r.outlineLean) || 1) || 0
    support.set(r, { pieces: own.length, share: shareAt(angle), ownLean, departs })
  }
  return support
}

/** What a row's own paint says about its lean (Find stalls on a photo taken at an angle): the paint
 * beside its double row, both halves (they share their dividers), seen from above, not along it. */
export interface PaintSupport {
  pieces: number
  /** Share of their length at the lean the row was given (within half a LEAN_STEP). */
  share: number
  /** The lean most of that paint shows (degrees, unsigned), or null with none. */
  ownLean: number | null
  /** The row's own paint clearly says another angle than the lot's, so it has that one. */
  departs: boolean
}

export interface StraightenOptions {
  /** Fit the ground on these spaces' outlines only (all of one kind, say the cars Find stalls outlined),
   * when there are enough; every outlined space is laid out on that ground. */
  fitOn?: ReadonlySet<string>
  /** Painted line pieces seen next to the stalls (x1, y1, x2, y2, photo fractions): they lie on the
   * ground, so the stalls' angle to their row is read from them when there are enough. */
  paint?: [number, number, number, number][]
}

export interface StraightenResult {
  draft: DraftLayout
  /** Spaces placed, stalls found in rows' gaps, rows found, spaces renamed, how far north turned (degrees
   * clockwise), and each row's lean in degrees, by row letter. */
  placed: number
  found: number
  rows: number
  renamed: number
  turned: number
  leans: Record<string, number>
  /** Spaces left in a row of fewer than 3, beside no other row: a car standing off the rows, say. */
  loose: string[]
  /** With paint: what each row's own paint says about its lean, by row letter. */
  paint: Record<string, PaintSupport>
}

function project(h: Mat3, [x, y]: Point): Point {
  const w = h[6] * x + h[7] * y + 1
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const len = (v: Point) => Math.hypot(v[0], v[1])

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** Solve A x = b (n x n, Gaussian elimination with partial pivoting); null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r
    if (Math.abs(m[p][c]) < 1e-12) return null
    ;[m[c], m[p]] = [m[p], m[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r][c] / m[c][c]
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]
    }
  }
  return m.map((row, i) => row[n] / row[i])
}

/** Sides of a quad mapped by `h`: front (shorter of the first two sides), divider (longer), and its shape errors. */
function shape(h: Mat3, q: Point[]) {
  const p = q.map((pt) => project(h, pt))
  const a = sub(p[1], p[0])
  const b = sub(p[3], p[0])
  const [front, divider] = len(a) <= len(b) ? [a, b] : [b, a]
  const par: Point = [p[0][0] + p[2][0] - p[1][0] - p[3][0], p[0][1] + p[2][1] - p[1][1] - p[3][1]]
  const cos = Math.abs(front[0] * divider[0] + front[1] * divider[1]) / (len(front) * len(divider) || 1)
  return { p, front, divider, par, cos }
}

/**
 * The homography that makes `quads` (normalised photo points) congruent parallelograms, with their front
 * edge `unit` long. Parameters: H's 8 entries, then the shared front length, divider length and |cos|.
 */
function fitGround(quads: Point[][], unit: number): Mat3 {
  const residuals = (x: number[]): number[] => {
    const h = x.slice(0, 8)
    const [w, d, c] = x.slice(8)
    const out: number[] = []
    for (const q of quads) {
      const s = shape(h, q)
      out.push(s.par[0], s.par[1], len(s.front) - w, len(s.divider) - d, (s.cos - c) * w)
    }
    out.push((w - unit) * 10) // fixes the scale
    return out
  }
  const lengths = quads.map((q) => {
    const a = len(sub(q[1], q[0]))
    const b = len(sub(q[3], q[0]))
    return [Math.min(a, b), Math.max(a, b)]
  })
  const scale = unit / median(lengths.map((l) => l[0]))
  let x = [scale, 0, 0, 0, scale, 0, 0, 0, unit, median(lengths.map((l) => l[1])) * scale, 0]
  let lambda = 1e-2
  let r = residuals(x)
  let cost = r.reduce((s, v) => s + v * v, 0)
  for (let it = 0; it < 200 && lambda < 1e12; it++) {
    const jac = x.map((_, j) => {
      const e = 1e-6 * Math.max(1, Math.abs(x[j]))
      const xp = [...x]
      xp[j] += e
      return residuals(xp).map((v, i) => (v - r[i]) / e)
    })
    const n = x.length
    const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => jac[i].reduce((s, v, t) => s + v * jac[k][t], 0)))
    const g = jac.map((col) => col.reduce((s, v, t) => s + v * r[t], 0))
    const damped = a.map((row, i) => row.map((v, k) => (i === k ? v + lambda * (v + 1e-9) : v)))
    const step = solve(damped, g.map((v) => -v))
    if (!step) {
      lambda *= 10
      continue
    }
    const next = x.map((v, i) => v + step[i])
    const nr = residuals(next)
    const ncost = nr.reduce((s, v) => s + v * v, 0)
    if (ncost < cost) {
      const done = cost - ncost < 1e-12 * cost
      ;[x, r, cost] = [next, nr, ncost]
      lambda = Math.max(lambda / 3, 1e-9)
      if (done) break
    } else {
      lambda *= 4
    }
  }
  return [...x.slice(0, 8), 1]
}

/** How far a quad is from the fitted stall shape, as a share of the stall's front edge. */
function misfit(h: Mat3, q: Point[], w: number, d: number): number {
  const s = shape(h, q)
  return (len(s.par) + Math.abs(len(s.front) - w) + Math.abs(len(s.divider) - d)) / w
}

/** Angle of a direction as a line (mod 180), doubled so near 0 and near 180 average together. */
function lineAngle(vectors: Point[]): number {
  const sx = vectors.reduce((s, v) => s + Math.cos(2 * Math.atan2(v[1], v[0])), 0)
  const sy = vectors.reduce((s, v) => s + Math.sin(2 * Math.atan2(v[1], v[0])), 0)
  return Math.atan2(sy, sx) / 2
}

const renamable = (label: string) => !label.trim() || parseLabel(label) !== null
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]
const unit = (v: Point): Point => {
  const l = len(v) || 1
  return [v[0] / l, v[1] / l]
}

/**
 * Photo pixels -> the ground seen straight down, for a camera with focal length `f` (square pixels,
 * principal point in the middle of a `w` x `h` photo) whose ground has vanishing line `l` (pixels).
 */
function groundView(
  l: [number, number, number],
  f: number,
  w: number,
  h: number,
): { toGround: (p: Point) => Point; toPhoto: (g: Point) => Point } {
  const n = [f * l[0], f * l[1], (w / 2) * l[0] + (h / 2) * l[1] + l[2]]
  const nl = Math.hypot(n[0], n[1], n[2]) || 1
  const [nx, ny, nz] = n.map((v) => v / nl)
  // The rotation taking the ground's normal to the view axis (Rodrigues about n x z).
  const [ax, ay] = [ny, -nx]
  const sin = Math.hypot(ax, ay)
  let r = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  if (sin > 1e-9) {
    const [kx, ky] = [ax / sin, ay / sin]
    const c = nz
    const v = 1 - c
    r = [c + kx * kx * v, kx * ky * v, ky * sin, kx * ky * v, c + ky * ky * v, -kx * sin, -ky * sin, kx * sin, c]
  }
  return {
    toGround: ([px, py]) => {
      const [x, y] = [(px - w / 2) / f, (py - h / 2) / f]
      const q = [r[0] * x + r[1] * y + r[2], r[3] * x + r[4] * y + r[5], r[6] * x + r[7] * y + r[8]]
      return [q[0] / q[2], q[1] / q[2]]
    },
    toPhoto: ([gx, gy]) => {
      // The rotation's transpose undoes it.
      const v = [r[0] * gx + r[3] * gy + r[6], r[1] * gx + r[4] * gy + r[7], r[2] * gx + r[5] * gy + r[8]]
      return [(f * v[0]) / v[2] + w / 2, (f * v[1]) / v[2] + h / 2]
    },
  }
}

interface GroundStall<T> {
  item: T
  corners: Point[] // the outline on the ground
  centre: Point
  divider: Point // unit, along the stall's long sides
  depth: number // divider length
}

interface Row<T> {
  stalls: GroundStall<T>[]
  dir: Point // unit, along the row
  lean: number // degrees, clockwise positive with the row running left to right
  outlineLean: number // what its double row's outlines alone say (its way, when its paint can't tell)
}

/** Rows (double rows split into their two) and how well they hang together; lower cost is better. */
function findRows<T>(stalls: GroundStall<T>[]): { rows: Row<T>[]; along: Point; cost: number } {
  const n = stalls.length
  const nearest = stalls.map((a, i) => {
    let best = -1
    stalls.forEach((b, j) => {
      if (j !== i && (best < 0 || len(sub(b.centre, a.centre)) < len(sub(stalls[best].centre, a.centre)))) best = j
    })
    return sub(stalls[best].centre, a.centre)
  })
  const spacing = median(nearest.map(len))
  const t = lineAngle(nearest)
  const along: Point = [Math.cos(t), Math.sin(t)]
  const maxTilt = Math.tan((ROW_TILT * Math.PI) / 180)
  const parent = stalls.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = sub(stalls[j].centre, stalls[i].centre)
      const a = Math.abs(dot(v, along))
      const across = Math.abs(v[0] * along[1] - v[1] * along[0])
      if (len(v) <= LINK_REACH * spacing && across <= maxTilt * a) parent[find(j)] = find(i)
    }
  }
  const groups = new Map<number, GroundStall<T>[]>()
  stalls.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]))

  const depth = median(stalls.map((s) => s.depth))
  /** A group's own line through its centres (a row may sit at a slight angle to the others). */
  const lineOf = (group: GroundStall<T>[]) => {
    const mx = group.reduce((t, s) => t + s.centre[0], 0) / group.length
    const my = group.reduce((t, s) => t + s.centre[1], 0) / group.length
    let dir = along
    if (group.length >= 3) {
      let [sxx, sxy, syy] = [0, 0, 0]
      for (const s of group) {
        const [dx, dy] = [s.centre[0] - mx, s.centre[1] - my]
        ;[sxx, sxy, syy] = [sxx + dx * dx, sxy + dx * dy, syy + dy * dy]
      }
      const a = 0.5 * Math.atan2(2 * sxy, sxx - syy)
      dir = [Math.cos(a), Math.sin(a)]
    }
    if (dot(dir, along) < 0) dir = [-dir[0], -dir[1]]
    return { mid: [mx, my] as Point, dir, side: [-dir[1], dir[0]] as Point }
  }
  // A stall in a group of fewer than 3 (drawn loosely, or a car standing at a row's end) joins the row
  // it sits beside: within a double row's width across its line and a couple of stalls past its ends.
  const all = [...groups.values()]
  const big = all.filter((g) => g.length >= 3).map((g) => ({ g, line: lineOf(g) }))
  for (const small of all.filter((g) => g.length < 3)) {
    for (const s of [...small]) {
      let home: (typeof big)[number] | null = null
      let closest = Infinity
      for (const b of big) {
        const across = Math.abs(dot(sub(s.centre, b.line.mid), b.line.side))
        const at = dot(sub(s.centre, b.line.mid), b.line.dir)
        const ends = b.g.map((t) => dot(sub(t.centre, b.line.mid), b.line.dir))
        const near = at >= Math.min(...ends) - 2 * spacing && at <= Math.max(...ends) + 2 * spacing
        if (near && across <= 1.2 * depth && across < closest) [home, closest] = [b, across]
      }
      if (home) {
        home.g.push(s)
        small.splice(small.indexOf(s), 1)
      }
    }
  }
  const rows: Row<T>[] = []
  for (const group of all.filter((g) => g.length > 0)) {
    let { dir } = lineOf(group)
    if (dot(dir, along) < 0) dir = [-dir[0], -dir[1]]
    const side: Point = [-dir[1], dir[0]]
    // A double row: the stalls' offsets across the line fall in two bunches, a stall depth apart.
    const sorted = [...group].sort((a, b) => dot(a.centre, side) - dot(b.centre, side))
    let cut = -1
    let widest = 0
    sorted.slice(1).forEach((s, k) => {
      const gap = dot(s.centre, side) - dot(sorted[k].centre, side)
      if (gap > widest) [widest, cut] = [gap, k + 1]
    })
    const halves = widest > 0.35 * depth ? [sorted.slice(0, cut), sorted.slice(cut)] : [sorted]
    // The two halves of a double row share their dividers (a line runs on across the middle), so they
    // lean alike: one lean from all the group's stalls, which also outvotes a half drawn loosely.
    const lean = median(
      group.map((s) => {
        let d = s.divider
        if (dot(d, side) < 0) d = [-d[0], -d[1]]
        // `side` points down the map when the row runs left to right: a side leaning right at the bottom
        // leans left at the top, anticlockwise, so the sign turns round (clockwise positive).
        return (-Math.atan2(dot(d, dir), dot(d, side)) * 180) / Math.PI
      }),
    )
    for (const half of halves) rows.push({ stalls: half, dir, lean, outlineLean: lean })
  }
  // Rows of fewer than 3 are loose ends; rows of a lot lean alike.
  const loose = rows.filter((r) => r.stalls.length < 3).reduce((t, r) => t + r.stalls.length, 0)
  const whole = rows.filter((r) => r.stalls.length >= 3)
  const mid = whole.length > 0 ? median(whole.flatMap((r) => r.stalls.map(() => Math.abs(r.lean)))) : 0
  const spread = whole.reduce((t, r) => t + r.stalls.length * Math.abs(Math.abs(r.lean) - mid), 0) / Math.max(1, n)
  // A lot is built at one parking angle: every row takes it, leaning its own way.
  for (const r of rows) r.lean = Math.sign(r.lean) * mid || 0 // never -0
  return { rows, along, cost: (100 * loose) / n + spread }
}

/**
 * The draft with the spaces outlined on `viewId`'s photo laid out top-down on the grid, or a reason it
 * can't be done. Spaces with no outline there keep their shape and go below the straightened ones.
 */
export function straightenFromPhoto(
  draft: DraftLayout,
  viewId: string,
  options: StraightenOptions = {},
): StraightenResult | string {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  const image = view?.referenceImage
  if (!view || !image) return 'This viewpoint has no reference photo.'
  const items = draft.spaces
    .filter((s) => !s.retired && view.outlines[s.spaceId]?.length === 4)
    .map((s) => ({ space: s, quad: view.outlines[s.spaceId].map(([x, y]) => [x * image.width, y * image.height] as Point) }))
  if (items.length < MIN_STRAIGHTEN) return `Outline at least ${MIN_STRAIGHTEN} spaces on this photo first (${items.length} so far).`

  // 1. The ground's vanishing line, from the homography that makes the outlines congruent. Normalised
  // photo points keep the fit well conditioned; the loosest outlines are left out of a second fit.
  const all = items.flatMap((it) => it.quad)
  const cx = all.reduce((s, p) => s + p[0], 0) / all.length
  const cy = all.reduce((s, p) => s + p[1], 0) / all.length
  const spread = Math.sqrt(all.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / all.length) || 1
  const fitItems = options.fitOn && items.filter((it) => options.fitOn!.has(it.space.spaceId)).length >= MIN_STRAIGHTEN
    ? items.filter((it) => options.fitOn!.has(it.space.spaceId))
    : items
  const quads = fitItems.map((it) => it.quad.map(([x, y]) => [(x - cx) / spread, (y - cy) / spread] as Point))
  let h = fitGround(quads, 0.2)
  const sizes = () => {
    const shapes = quads.map((q) => shape(h, q))
    return { w: median(shapes.map((s) => len(s.front))), d: median(shapes.map((s) => len(s.divider))) }
  }
  const { w, d } = sizes()
  const errors = quads.map((q) => misfit(h, q, w, d))
  const kept = quads.filter((_, i) => errors[i] <= 3 * median(errors))
  if (kept.length >= MIN_STRAIGHTEN && kept.length < quads.length) h = fitGround(kept, 0.2)
  const horizon: [number, number, number] = [h[6] / spread, h[7] / spread, 1 - (h[6] * cx + h[7] * cy) / spread]

  // 2. The camera's focal length: the one that keeps rows whole with their leans agreeing, near a usual lens.
  const tryFocal = (share: number) => {
    const camera = groundView(horizon, share * image.width, image.width, image.height)
    const toGround = camera.toGround
    const stalls = items.map((it) => {
      const g = it.quad.map(toGround)
      const a = sub(g[1], g[0])
      const b = sub(g[3], g[0])
      const divider = len(a) >= len(b) ? a : b
      const centre: Point = [g.reduce((t, p) => t + p[0], 0) / 4, g.reduce((t, p) => t + p[1], 0) / 4]
      return { item: it, corners: g, centre, divider: unit(divider), depth: len(divider) }
    })
    const rowsFound = findRows(stalls)
    return { stalls, camera, ...rowsFound, cost: rowsFound.cost + 4 * Math.abs(Math.log(share / FOCAL_USUAL)) }
  }
  const best = FOCAL_TRIES.map(tryFocal).reduce((a, b) => (b.cost < a.cost ? b : a))
  const support = options.paint?.length ? paintLeans(best.rows, best.stalls, options.paint, best.camera, image) : null
  const { stalls, camera } = best

  // 3. Turn the ground so rows run left to right.
  let theta = Math.atan2(best.along[1], best.along[0])
  if (theta > Math.PI / 2) theta -= Math.PI
  if (theta <= -Math.PI / 2) theta += Math.PI
  // Of the two ways round, keep the camera's: what is higher in the photo (further away) stays higher on the map.
  const photoY = items.map((it) => it.quad.reduce((t, p) => t + p[1], 0) / 4)
  const mapY = (a: number) => stalls.map((t) => Math.sin(a) * t.centre[0] + Math.cos(a) * t.centre[1])
  const agree = (ys: number[]) => {
    const [mp, mm] = [photoY.reduce((t, v) => t + v, 0) / ys.length, ys.reduce((t, v) => t + v, 0) / ys.length]
    return ys.reduce((t, v, i) => t + (v - mm) * (photoY[i] - mp), 0)
  }
  if (agree(mapY(-theta)) < 0) theta += Math.PI
  const [c, s] = [Math.cos(-theta), Math.sin(-theta)]
  const turn = ([x, y]: Point): Point => [c * x - s * y, s * x + c * y]
  const unturn = ([x, y]: Point): Point => [c * x + s * y, -s * x + c * y]
  const rows = best.rows.map((r) => {
    // A lean reads the same from either end of its row, so turning the row round leaves it be.
    let dir = turn(r.dir)
    if (dir[0] < 0) dir = [-dir[0], -dir[1]]
    const centres = r.stalls.map((t) => turn(t.centre))
    return { ...r, source: r, dir, centres, y: median(centres.map((p) => p[1])) }
  })
  rows.sort((a, b) => a.y - b.y)
  for (const r of rows) {
    const order = r.stalls.map((t, i) => ({ t, p: r.centres[i] })).sort((a, b) => dot(a.p, r.dir) - dot(b.p, r.dir))
    r.stalls = order.map((o) => o.t)
    r.centres = order.map((o) => o.p)
  }
  // The ground view is the photo turned, never mirrored, so a lean keeps its sign on the map.
  const depth = median(stalls.map((t) => t.depth)) * Math.cos((median(rows.map((r) => Math.abs(r.lean))) * Math.PI) / 180)
  const steps = rows.flatMap((r) => r.centres.slice(1).map((p, i) => dot(sub(p, r.centres[i]), r.dir))).filter((v) => v > 0)
  const spacing = steps.length > 0 ? median(steps) : 1
  const pitch = median(steps.filter((v) => v > 0.6 * spacing)) || spacing
  const left = Math.min(...rows.flatMap((r) => r.centres.map((p) => p[0])))

  // 4. Boxes: the lot's usual space width, as deep as the ground says.
  const widths = draft.spaces.filter((sp) => !sp.retired).map((sp) => sp.rect.w)
  const boxW = Math.min(110, Math.max(20, Math.round(median(widths))))
  const scale = boxW / pitch
  const boxH = Math.round(boxW * Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, (depth * scale) / boxW)))

  const placed = new Map<string, { rect: DraftRect; label?: string; skewDeg?: number }>()
  // Stalls found in rows' gaps: their cell, label, lean and outline on the photo (fractions).
  const gaps: { rect: DraftRect; label?: string; skewDeg?: number; outline: Outline }[] = []
  const onPhoto = (q: Point[]): Outline | null => {
    const out = q.map((g) => {
      const [px, py] = camera.toPhoto(g)
      return [px / image.width, py / image.height] as Point
    })
    return out.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1) ? out : null
  }
  // Labels no straightened space may take: names like "Gate", and every label of a space not laid out
  // here (seen only on another photo), which keeps its own.
  const onRows = new Set(rows.flatMap((row) => row.stalls.map((t) => t.item.space.spaceId)))
  const keptLabels = new Set(
    draft.spaces
      .filter((sp) => !sp.retired && sp.label.trim() && (!renamable(sp.label) || !onRows.has(sp.spaceId)))
      .map((sp) => sp.label.trim().toUpperCase()),
  )
  const leans: Record<string, number> = {}
  const paintSupport: Record<string, PaintSupport> = {}
  let y = MARGIN
  let renamed = 0
  // Drives between rows: a lot has one aisle width, so every drive gets the typical one, scaled like the
  // stalls' depth (boxH, which may have been held to a stall's shape).
  const between = rows.slice(1).map((row, i) => row.y - rows[i].y - depth)
  const drives = between.filter((g) => g > BACK_TO_BACK * depth)
  const aisle = drives.length > 0 ? Math.round((boxH * median(drives)) / depth) : 0
  rows.forEach((row, i) => {
    if (i > 0) y += boxH + (between[i - 1] > BACK_TO_BACK * depth ? aisle : 0)
    const letter = i < 26 ? String.fromCharCode(65 + i) : undefined
    const snapped = Math.round(row.lean / LEAN_STEP) * LEAN_STEP
    const skew = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, snapped)) || 0 // never -0
    if (letter) leans[letter] = skew
    const backing = support?.get(row.source)
    if (letter && backing) paintSupport[letter] = backing
    // Numbered along the row from where it starts; a gap of a missing stall or more is kept.
    const start = Math.max(0, Math.round((row.centres[0][0] - left) / pitch))
    const used = new Set<number>()
    let along = 0
    let prevCol = -1
    const step = unturn(row.dir) // one stall along the row, on the ground
    // Where each stall starts and ends along its row's middle line, on the turned ground: its front
    // edge (the side running most along the row) about its middle. Corners won't do: a leaning stall's
    // overlap its neighbours'.
    const extent = row.stalls.map((t, k) => {
      const g = t.corners.map(turn)
      const [a, b] = [sub(g[1], g[0]), sub(g[3], g[0])]
      const across = (v: Point) => Math.abs(v[0] * row.dir[1] - v[1] * row.dir[0]) / (len(v) || 1)
      const front = across(a) <= across(b) ? a : b
      const half = Math.abs(dot(front, row.dir)) / 2
      const mid = dot(row.centres[k], row.dir)
      return [mid - half, mid + half]
    })
    row.stalls.forEach((t, k) => {
      if (k > 0) {
        // Count the stalls that fit between their middles; but a wide stall (a van bay) side by side with
        // its neighbour, no stall's room between them, is just the next number.
        const steps = Math.max(1, Math.round(dot(sub(row.centres[k], row.centres[k - 1]), row.dir) / pitch))
        const gap = extent[k][0] - extent[k - 1][1]
        const wide = Math.max(extent[k][1] - extent[k][0], extent[k - 1][1] - extent[k - 1][0]) >= 1.3 * pitch
        along += wide && gap < 0.5 * pitch ? 1 : steps
      }
      let col = start + along
      while (used.has(col)) col++
      used.add(col)
      // A gap of a few stalls inside the row: the stalls missing there, copied along from the one before.
      if (k > 0 && col - prevCol > 1 && col - prevCol - 1 <= MAX_GAP) {
        const before = row.stalls[k - 1].corners
        for (let gap = prevCol + 1; gap < col; gap++) {
          const shift = (gap - prevCol) * pitch
          const outline = onPhoto(before.map(([x, y]) => [x + step[0] * shift, y + step[1] * shift] as Point))
          if (!outline) continue
          used.add(gap)
          const rect = { x: MARGIN + gap * boxW, y, w: boxW, h: boxH }
          gaps.push({ rect, label: letter && formatLabel(letter, gap + 1), skewDeg: skew || undefined, outline })
        }
      }
      prevCol = col
      const sp = t.item.space
      const label = letter && renamable(sp.label) ? formatLabel(letter, col + 1) : undefined
      const free = label && !keptLabels.has(label)
      if (free && label !== sp.label) renamed++
      placed.set(sp.spaceId, { rect: { x: MARGIN + col * boxW, y, w: boxW, h: boxH }, label: free ? label : undefined, skewDeg: skew || undefined })
    })
  })

  // North turns with the map: the rotation that best carries the old positions onto the new ones.
  const centreOf = (r: DraftRect): Point => [r.x + r.w / 2, r.y + r.h / 2]
  const pairs = items.map((it) => [centreOf(it.space.rect), centreOf(placed.get(it.space.spaceId)!.rect)])
  const mean = (k: 0 | 1, axis: 0 | 1) => pairs.reduce((t, p) => t + p[k][axis], 0) / pairs.length
  const [ox, oy, nx, ny] = [mean(0, 0), mean(0, 1), mean(1, 0), mean(1, 1)]
  let cross = 0
  let dotSum = 0
  for (const [[ax, ay], [bx, by]] of pairs) {
    cross += (ax - ox) * (by - ny) - (ay - oy) * (bx - nx)
    dotSum += (ax - ox) * (bx - nx) + (ay - oy) * (by - ny)
  }
  const turned = Math.round((Math.atan2(cross, dotSum) * 180) / Math.PI)
  const north = draft.schematic.northDeg
  const northDeg = north == null ? north : (((north + turned) % 360) + 360) % 360

  // Spaces not on this photo keep their shape, moved below the straightened ones.
  const bottom = Math.max(...[...placed.values()].map((p) => p.rect.y + p.rect.h))
  const others = draft.spaces.filter((sp) => !placed.has(sp.spaceId))
  const otherTop = others.length > 0 ? Math.min(...others.map((sp) => sp.rect.y)) : 0
  const otherLeft = others.length > 0 ? Math.min(...others.map((sp) => sp.rect.x)) : 0
  const spaces: DraftSpace[] = draft.spaces.map((sp): DraftSpace => {
    const p = placed.get(sp.spaceId)
    if (!p) return { ...sp, rect: { ...sp.rect, x: sp.rect.x - otherLeft + MARGIN, y: sp.rect.y - otherTop + bottom + 2 * MARGIN } }
    const next: DraftSpace = { ...sp, rect: p.rect, label: p.label ?? sp.label }
    if (p.skewDeg) next.skewDeg = p.skewDeg
    else delete next.skewDeg
    return next
  })
  // A straightened space whose row label was taken keeps its old one, unless another space now has
  // that too: then it is left blank for the admin to name (validation points at it).
  const finalCount = new Map<string, number>()
  for (const sp of spaces) if (!sp.retired && sp.label.trim()) finalCount.set(sp.label.trim().toUpperCase(), (finalCount.get(sp.label.trim().toUpperCase()) ?? 0) + 1)
  for (const sp of spaces) {
    const p = placed.get(sp.spaceId)
    const key = sp.label.trim().toUpperCase()
    if (!p || p.label || !renamable(sp.label) || !key || (finalCount.get(key) ?? 0) < 2) continue
    finalCount.set(key, finalCount.get(key)! - 1)
    sp.label = ''
  }
  // The stalls found in gaps: new spaces with proposed outlines waiting for review.
  const taken = new Set(spaces.map((sp) => sp.spaceId))
  const labels = new Set(spaces.filter((sp) => !sp.retired).map((sp) => sp.label.trim().toUpperCase()))
  const outlines = { ...view.outlines }
  const outlineReview: Record<string, OutlineReview> = { ...view.outlineReview }
  for (const g of gaps) {
    const spaceId = newSpaceId(taken)
    taken.add(spaceId)
    const label = g.label && !labels.has(g.label) ? g.label : ''
    if (label) labels.add(label)
    spaces.push({ spaceId, label, type: 'STANDARD', rect: g.rect, retired: false, ...(g.skewDeg ? { skewDeg: g.skewDeg } : {}) })
    outlines[spaceId] = g.outline
    outlineReview[spaceId] = { source: 'proposed', status: 'pending', evidence: GAP_EVIDENCE, newSpace: true }
  }
  const viewpoints = gaps.length ? draft.viewpoints.map((v) => (v.viewId === viewId ? { ...v, outlines, outlineReview } : v)) : draft.viewpoints
  const width = Math.ceil(Math.max(...spaces.map((sp) => sp.rect.x + sp.rect.w))) + MARGIN
  const height = Math.ceil(Math.max(...spaces.map((sp) => sp.rect.y + sp.rect.h))) + MARGIN
  const schematic = { ...draft.schematic, width, height }
  if (northDeg == null) delete schematic.northDeg
  else schematic.northDeg = northDeg
  return {
    draft: { ...draft, schematic, spaces, viewpoints },
    placed: placed.size,
    found: gaps.length,
    rows: rows.length,
    renamed,
    turned,
    leans,
    paint: paintSupport,
    loose: rows.filter((r) => r.stalls.length < 3).flatMap((r) => r.stalls.map((t) => t.item.space.spaceId)),
  }
}

/** Rounds of dropping stray cars and straightening again (a row can break up once its strays go). */
const STRAY_ROUNDS = 3

/**
 * Straighten stalls Find stalls found from parked cars (a photo taken at an angle): as
 * straightenFromPhoto, but a car standing off the rows (driving through, or stopped in the aisle) is no
 * stall, so its proposal is dropped and the rest are straightened again, until none is left over.
 * `dropped` counts them and `droppedIds` names them (the caller may put them back: addLeftOutCars).
 *
 * On a lot that already has spaces, `stalls` (the whole Find stalls run, cars on spaces included) keeps
 * the outlines alike: the ground is fitted on car outlines only, and a space the lot had is seen by the
 * car outline lying on it, when one does (a hand-drawn box and a car's footprint differ in shape). Every
 * space keeps its own outline; only its place on the map, label and lean come from the straightening.
 */
export function straightenFoundCars(
  draft: DraftLayout,
  viewId: string,
  paint: [number, number, number, number][] = [],
  stalls: { polygon: Point[]; fromCar?: boolean | null }[] = [],
  newIds?: ReadonlySet<string>,
): (StraightenResult & { dropped: number; droppedIds: string[] }) | string {
  let current = draft
  let dropped = 0
  const droppedIds: string[] = []
  for (let round = 0; ; round++) {
    const view = current.viewpoints.find((v) => v.viewId === viewId)!
    const review = view.outlineReview
    const found = newIds
      ? new Set([...newIds].filter((id) => review[id]?.status === 'pending'))
      : new Set(Object.keys(review).filter((id) => review[id]?.newSpace && review[id]?.status === 'pending'))
    // The fit sees each space the lot had by the car outline on it, if any.
    const cars = new Set(found)
    const seen: Record<string, Outline> = { ...view.outlines }
    for (const sp of current.spaces) {
      const own = view.outlines[sp.spaceId] as Point[] | undefined
      if (sp.retired || !own || found.has(sp.spaceId)) continue
      const best = stalls
        .filter((st) => st.fromCar)
        .map((st) => ({ st, share: area(clipPolygon(own, st.polygon)) / (area(own) || 1) }))
        .reduce<{ st: (typeof stalls)[number]; share: number } | null>((a, b) => (!a || b.share > a.share ? b : a), null)
      if (best && best.share >= 0.3) {
        seen[sp.spaceId] = best.st.polygon as Outline
        cars.add(sp.spaceId)
      }
    }
    const lookedAt: DraftLayout = { ...current, viewpoints: current.viewpoints.map((v) => (v.viewId === viewId ? { ...v, outlines: seen } : v)) }
    const result = straightenFromPhoto(lookedAt, viewId, { paint, fitOn: cars })
    if (typeof result === 'string') return result
    const drop = new Set(result.loose.filter((id) => found.has(id)))
    if (drop.size === 0 || round === STRAY_ROUNDS) {
      // Back to the spaces' own outlines; spaces the straightening found in gaps keep theirs.
      const placed = result.draft
      const out = placed.viewpoints.find((v) => v.viewId === viewId)!
      const outlines = { ...out.outlines }
      for (const id of Object.keys(view.outlines)) outlines[id] = view.outlines[id]
      return {
        ...result,
        dropped,
        droppedIds,
        draft: { ...placed, viewpoints: placed.viewpoints.map((v) => (v.viewId === viewId ? { ...out, outlines } : v)) },
      }
    }
    dropped += drop.size
    droppedIds.push(...drop)
    const keep = ([id]: [string, unknown]) => !drop.has(id)
    current = {
      ...current,
      spaces: current.spaces.filter((sp) => !drop.has(sp.spaceId)),
      viewpoints: current.viewpoints.map((v) =>
        v.viewId !== viewId
          ? v
          : { ...v, outlines: Object.fromEntries(Object.entries(v.outlines).filter(keep)), outlineReview: Object.fromEntries(Object.entries(v.outlineReview).filter(keep)) },
      ),
    }
  }
}
