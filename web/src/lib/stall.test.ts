import { describe, expect, it } from 'vitest'
import { turnedBox, turn, unturn } from './mapView'
import { rowEnds, stallPoints } from './stall'

describe('stallPoints', () => {
  it('is null for a square stall', () => {
    expect(stallPoints({ x: 0, y: 0, w: 40, h: 80 }, 0)).toBeNull()
    expect(stallPoints({ x: 0, y: 0, w: 40, h: 80 }, null)).toBeNull()
  })

  it('leans a tall stall clockwise: top right, bottom left, centred on the cell', () => {
    expect(stallPoints({ x: 100, y: 0, w: 40, h: 80 }, 45)).toBe('140,0 180,0 100,80 60,80')
  })

  it('cuts the stalls at a row end square, so the row is a strip with slanted dividers', () => {
    // The row runs from x 100 to 180: the first stall loses its overhang on the left.
    expect(stallPoints({ x: 100, y: 0, w: 40, h: 80 }, 45, [100, 180])).toBe('140,0 180,0 100,80 100,40')
  })

  it('leans a wide stall (a row running down the map) along its long side', () => {
    expect(stallPoints({ x: 0, y: 100, w: 80, h: 40 }, 45)).toBe('0,60 80,140 80,180 0,100')
  })
})

describe('rowEnds', () => {
  it('finds each row by height and depth, and its two ends', () => {
    const ends = rowEnds([
      { spaceId: 'a', rect: { x: 20, y: 0, w: 40, h: 80 } },
      { spaceId: 'b', rect: { x: 60, y: 0, w: 40, h: 80 } },
      { spaceId: 'c', rect: { x: 60, y: 80, w: 40, h: 80 } },
    ])
    expect(ends.get('a')).toEqual([20, 100])
    expect(ends.get('c')).toEqual([60, 100])
  })
})

describe('turning the map', () => {
  it('turns clockwise about the middle and back', () => {
    const [x, y] = turn([10, 0], 90, 0, 0)
    expect([Math.round(x), Math.round(y)]).toEqual([0, 10]) // right turns to down
    const back = unturn([x, y], 90, 0, 0)
    expect(back.map(Math.round)).toEqual([10, 0])
  })

  it('a quarter turn swaps the box round its middle', () => {
    const b = turnedBox(200, 100, 90)
    expect([b.x, b.y, b.w, b.h].map((v) => Math.round(v))).toEqual([50, -50, 100, 200])
  })
})
