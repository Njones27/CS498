import type { CarBoxOut } from '../api/schemas'

/** Classes the worker counts as cars (car overlap); every other class is shown for debugging only. */
export const CAR_CLASSES: ReadonlySet<string> = new Set(['car', 'truck', 'bus'])

/** "5 car, 56 cell phone": detections per class, most frequent first. */
export function classBreakdown(boxes: CarBoxOut[]): string {
  const counts = new Map<string, number>()
  boxes.forEach((b) => counts.set(b.clsName, (counts.get(b.clsName) ?? 0) + 1))
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${n} ${cls}`)
    .join(', ')
}
