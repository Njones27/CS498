import type { Point } from '../types'

/** Clamp a value between min and max (defaults 0..1). */
export function clamp(val: number, min = 0, max = 1): number {
  return Math.min(Math.max(val, min), max)
}

/**
 * Order 4 points clockwise around their centroid in screen space (where y points down).
 * Anchors the start of the sequence at the top-left vertex (minimizing x + y) so that
 * the sequence is consistently: [Top-Left, Top-Right, Bottom-Right, Bottom-Left].
 */
export function orderClockwise(points: Point[]): Point[] {
  if (points.length <= 2) return [...points]
  const cx = points.reduce((acc, p) => acc + p[0], 0) / points.length
  const cy = points.reduce((acc, p) => acc + p[1], 0) / points.length

  const sorted = [...points].sort((a, b) => {
    const angleA = Math.atan2(a[1] - cy, a[0] - cx)
    const angleB = Math.atan2(b[1] - cy, b[0] - cx)
    return angleA - angleB
  })

  // Anchor to top-left corner (minimum x + y)
  let minIdx = 0
  let minScore = Infinity
  for (let i = 0; i < sorted.length; i++) {
    const score = sorted[i][0] + sorted[i][1]
    if (score < minScore) {
      minScore = score
      minIdx = i
    }
  }

  return [...sorted.slice(minIdx), ...sorted.slice(0, minIdx)]
}

/** Convert a 0..1 fractional point to SVG pixel coordinates. */
export function pointToSvgPx(point: Point, width: number, height: number): [number, number] {
  return [point[0] * width, point[1] * height]
}

/** Convert SVG pixel coordinates to a 0..1 fractional point, clamped. */
export function svgPxToPoint(x: number, y: number, width: number, height: number): Point {
  const fx = width > 0 ? clamp(x / width) : 0
  const fy = height > 0 ? clamp(y / height) : 0
  return [Number(fx.toFixed(4)), Number(fy.toFixed(4))]
}

/** Convert an outline of 0..1 points into an SVG polygon points string. */
export function polygonToSvgPoints(points: Point[], width: number, height: number): string {
  return points.map((p) => `${p[0] * width},${p[1] * height}`).join(' ')
}

/** Compute the visual center of a polygon for placing labels. */
export function polygonCenter(points: Point[], width: number, height: number): [number, number] {
  if (points.length === 0) return [0, 0]
  const cx = points.reduce((acc, p) => acc + p[0], 0) / points.length
  const cy = points.reduce((acc, p) => acc + p[1], 0) / points.length
  return [cx * width, cy * height]
}

/**
 * Get fractional point [0..1, 0..1] from a mouse/pointer event on an SVG element.
 * Uses getScreenCTM() when available to avoid any viewBox / aspect-ratio offsets.
 */
export function getSvgPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  svgWidth: number,
  svgHeight: number,
): Point {
  if (typeof svg.getScreenCTM === 'function' && typeof svg.createSVGPoint === 'function') {
    const ctm = svg.getScreenCTM()
    if (ctm) {
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const p = pt.matrixTransform(ctm.inverse())
      return [
        Number(clamp(p.x / svgWidth).toFixed(4)),
        Number(clamp(p.y / svgHeight).toFixed(4)),
      ]
    }
  }
  const rect = svg.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return [0, 0]
  return svgPxToPoint(clientX - rect.left, clientY - rect.top, rect.width, rect.height)
}

// The server's quad rule (core/parking_core/layouts.py is_valid_quad), so the client never saves an
// outline that publishing would reject as bad_polygon.
const EPS = 1e-9
const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
const onSegment = (p: Point, q: Point, r: Point) =>
  Math.min(p[0], q[0]) - EPS <= r[0] &&
  r[0] <= Math.max(p[0], q[0]) + EPS &&
  Math.min(p[1], q[1]) - EPS <= r[1] &&
  r[1] <= Math.max(p[1], q[1]) + EPS

/** True if the closed segments p1p2 and q1q2 share any point. */
function segmentsTouch(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const d1 = cross(q1, q2, p1)
  const d2 = cross(q1, q2, p2)
  const d3 = cross(p1, p2, q1)
  const d4 = cross(p1, p2, q2)
  const straddles = (a: number, b: number) => (a > EPS && b < -EPS) || (a < -EPS && b > EPS)
  if (straddles(d1, d2) && straddles(d3, d4)) return true
  return (
    (Math.abs(d1) <= EPS && onSegment(q1, q2, p1)) ||
    (Math.abs(d2) <= EPS && onSegment(q1, q2, p2)) ||
    (Math.abs(d3) <= EPS && onSegment(p1, p2, q1)) ||
    (Math.abs(d4) <= EPS && onSegment(p1, p2, q2))
  )
}

/** Four corners, non-zero area, and no edge crossing or touching the opposite edge (a repeated corner touches). */
export function isValidQuad(polygon: Point[]): boolean {
  if (polygon.length !== 4) return false
  const [a, b, c, d] = polygon
  const origin: Point = [0, 0]
  const area2 = cross(origin, a, b) + cross(origin, b, c) + cross(origin, c, d) + cross(origin, d, a)
  if (Math.abs(area2) <= EPS) return false
  return !(segmentsTouch(a, b, c, d) || segmentsTouch(b, c, d, a))
}

/** Matches `PHOTO_EDGE` in parking_core.models: a corner this close to the border is on it. */
const PHOTO_EDGE = 0.001

/**
 * An outline drawn up to the photo's border: a stall the photo cuts off, outlined only where it is
 * in view. The worker never calls such a stall Free (`touches_photo_edge` on the server); another
 * viewpoint that sees it whole decides it.
 */
export function touchesPhotoEdge(outline: Point[]): boolean {
  return outline.some(onBorder)
}

/** On the border itself: a corner past it (a whole stall's outline, while being placed) is not. */
const onBorder = ([x, y]: Point) =>
  [x, y].some((v) => Math.abs(v) <= PHOTO_EDGE || Math.abs(1 - v) <= PHOTO_EDGE)

/**
 * An outline the border cuts through: the part in view of a stall that runs off the photo, which has a
 * side along the border (two corners on it). Its middle is not the stall's middle, so it can't stand for
 * where the stall is. A whole stall merely flush with the border has one corner there and still can.
 */
export function cutByBorder(outline: Point[]): boolean {
  return outline.filter(onBorder).length >= 2
}
