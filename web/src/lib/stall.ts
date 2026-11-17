import type { components } from '../api/types.gen'

type Rect = components['schemas']['RectOut']

type Pt = [number, number]

/** Keep the part of a convex polygon between x = lo and x = hi (Sutherland-Hodgman, two edges). */
function clipX(points: Pt[], lo: number, hi: number): Pt[] {
  const cut = (pts: Pt[], keep: (p: Pt) => boolean, edge: number): Pt[] => {
    const out: Pt[] = []
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length]
      const [pin, qin] = [keep(p), keep(q)]
      if (pin) out.push(p)
      if (pin !== qin) {
        const t = (edge - p[0]) / (q[0] - p[0])
        out.push([edge, p[1] + t * (q[1] - p[1])])
      }
    })
    return out
  }
  const out = cut(cut(points, (p) => p[0] >= lo, lo), (p) => p[0] <= hi, hi)
  // A corner on the cut line comes back twice: keep it once.
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length]
    return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9
  })
}

/**
 * An angled stall's outline on the map: the parallelogram leaning `skewDeg` (clockwise positive) in its
 * cell, its sides along the cell's long axis (a row of tall cells has upright dividers), centred on the
 * cell so its label stays inside. With `row` (the row's left and right ends), the stalls at the ends are
 * cut square there, so the row reads as a strip with slanted dividers across it, as painted. Points for
 * an SVG <polygon>; null for a square stall (draw the rect).
 */
export function stallPoints(r: Rect, skewDeg?: number | null, row?: [number, number]): string | null {
  if (!skewDeg) return null
  const t = Math.tan((skewDeg * Math.PI) / 180)
  let pts: Pt[]
  if (r.h >= r.w) {
    const o = (r.h * t) / 2 // the top edge moves right, the bottom left
    pts = [[r.x + o, r.y], [r.x + r.w + o, r.y], [r.x + r.w - o, r.y + r.h], [r.x - o, r.y + r.h]]
    if (row) pts = clipX(pts, row[0], row[1])
  } else {
    const o = (r.w * t) / 2 // the right edge moves down, the left up
    pts = [[r.x, r.y - o], [r.x + r.w, r.y + o], [r.x + r.w, r.y + r.h + o], [r.x, r.y + r.h - o]]
  }
  return pts.map(([x, y]) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`).join(' ')
}

/**
 * Each row's left and right ends (by space id): spaces side by side at the same height and depth. A stall
 * on its own is no row: it has no ends, so it is drawn as the whole leaning stall, not cut on both sides.
 */
export function rowEnds(spaces: { spaceId: string; rect: Rect }[]): Map<string, [number, number]> {
  const rows = new Map<string, { ids: string[]; lo: number; hi: number }>()
  for (const s of spaces) {
    const key = `${Math.round(s.rect.y)}:${Math.round(s.rect.h)}`
    const row = rows.get(key) ?? { ids: [], lo: Infinity, hi: -Infinity }
    row.ids.push(s.spaceId)
    row.lo = Math.min(row.lo, s.rect.x)
    row.hi = Math.max(row.hi, s.rect.x + s.rect.w)
    rows.set(key, row)
  }
  const ends = new Map<string, [number, number]>()
  for (const row of rows.values()) if (row.ids.length > 1) for (const id of row.ids) ends.set(id, [row.lo, row.hi])
  return ends
}
