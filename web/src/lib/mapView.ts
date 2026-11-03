/** Turning a map for display, like a photo turned in an editor: clockwise by `deg` about its middle. */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Map point -> where it shows once the map is turned `deg` clockwise about (cx, cy). */
export function turn([x, y]: [number, number], deg: number, cx: number, cy: number): [number, number] {
  const a = (deg * Math.PI) / 180
  const [c, s] = [Math.cos(a), Math.sin(a)]
  const [dx, dy] = [x - cx, y - cy]
  return [cx + c * dx - s * dy, cy + s * dx + c * dy]
}

/** Where a point shown on the turned map lies on the map itself. */
export const unturn = (p: [number, number], deg: number, cx: number, cy: number) => turn(p, -deg, cx, cy)

/** The box the whole map (0, 0, width, height) fills once turned. */
export function turnedBox(width: number, height: number, deg: number): Box {
  if (!deg) return { x: 0, y: 0, w: width, h: height }
  const corners = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map((p) => turn(p as [number, number], deg, width / 2, height / 2))
  const xs = corners.map((p) => p[0])
  const ys = corners.map((p) => p[1])
  const r = (v: number) => Math.round(v * 1000) / 1000
  return { x: r(Math.min(...xs)), y: r(Math.min(...ys)), w: r(Math.max(...xs) - Math.min(...xs)), h: r(Math.max(...ys) - Math.min(...ys)) }
}

/** An angle in [0, 360). */
export const normalDeg = (deg: number) => ((Math.round(deg) % 360) + 360) % 360
