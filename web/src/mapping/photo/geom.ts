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
