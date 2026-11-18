import type { CarBoxOut } from '../api/schemas'

/** Classes the worker counts as cars (car overlap). Every other class YOLO reports is left out of the photo view. */
export const CAR_CLASSES: ReadonlySet<string> = new Set(['car', 'truck', 'bus'])

/** The detections that count as cars. A drone photo also gets many "cell phone" hits, which the scorer ignores. */
export function carBoxes(boxes: CarBoxOut[]): CarBoxOut[] {
  return boxes.filter((b) => CAR_CLASSES.has(b.clsName))
}

/** "8 cars": car, truck and bus detections counted together as cars. */
export function carCount(boxes: CarBoxOut[]): string {
  const n = carBoxes(boxes).length
  return n === 0 ? 'no cars' : `${n} ${n === 1 ? 'car' : 'cars'}`
}
