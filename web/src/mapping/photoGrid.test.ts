import { describe, expect, it } from 'vitest'
import { davidFixture, space } from './fixtures/david'
import { placeFromPhoto, photoCell } from './photoGrid'
import { cellRect, fitGrid } from './schematic/grid'
import { addSpaceFromOutline } from './sync'
import type { DraftLayout, Outline } from './types'

// A photo of rows B to E, columns at x 0.10 + 0.04c. Rows C to E are numbered from column 0 (C-01
// at column 0); row B, as in the drone lot's seed, from column 1: its B-01 is above C-02, and the photo
// spot above C-01 has no space yet. On the schematic, row B is drawn stretched.
const at = (col: number, y: number): Outline => {
  const x = 0.1 + col * 0.04
  return [
    [x, y],
    [x + 0.035, y],
    [x + 0.035, y + 0.1],
    [x, y + 0.1],
  ]
}
const ROW_Y = { B: 0.1, C: 0.3, D: 0.5, E: 0.7 }

function lot(): DraftLayout {
  const spaces = [
    ...[1, 2, 3, 4].map((n) => space(`B-0${n}`, 0, 0, { rect: { x: 20 + (n - 1) * 60, y: 34, w: 50, h: 72 } })),
    ...(['C', 'D', 'E'] as const).flatMap((r, i) =>
      [1, 2, 3, 4, 5].map((n) => space(`${r}-0${n}`, 0, 0, { rect: { x: 20 + (n - 1) * 45, y: 124 + i * 90, w: 40, h: 72 } })),
    ),
  ]
  const outlines: Record<string, Outline> = {}
  for (const s of spaces) {
    const row = s.label[0] as keyof typeof ROW_Y
    const n = Number(s.label.slice(2))
    outlines[s.spaceId] = at(row === 'B' ? n : n - 1, ROW_Y[row]) // B-0n sits in column n
  }
  return davidFixture({ spaces, viewpoints: [{ ...davidFixture().viewpoints[0], outlines, outlineReview: {} }] })
}

describe('photoCell', () => {
  it('reads the row off the outlines beside it and the column off the row below', () => {
    const draft = lot()
    expect(photoCell(draft, draft.viewpoints[0], at(0, ROW_Y.B))).toEqual({ row: 1, col: 0 })
    expect(photoCell(draft, draft.viewpoints[0], at(3, ROW_Y.C))).toEqual({ row: 2, col: 3 })
    // A new row below E.
    expect(photoCell(draft, draft.viewpoints[0], at(2, 0.9))).toEqual({ row: 5, col: 2 })
  })
})

describe('a box drawn on the photo before the first space of a row', () => {
  it('becomes B-01; the rest of row B is renumbered to the photo and moved into its cells', () => {
    const draft = lot()
    const grid = fitGrid(draft.spaces)
    const { draft: next, space: added, note } = addSpaceFromOutline(draft, 'V1', at(0, ROW_Y.B), grid)
    expect(added.label).toBe('B-01')
    const label = (id: string) => next.spaces.find((s) => s.spaceId === id)!.label
    expect(['B-01', 'B-02', 'B-03', 'B-04'].map(label)).toEqual(['B-02', 'B-03', 'B-04', 'B-05'])
    expect(next.spaces.find((s) => s.spaceId === 'B-01')!.rect).toEqual(cellRect(grid, { row: 1, col: 1 }))
    expect(note).toBe('Now B-01; row B renumbered to match the photo')
  })

  it('a box drawn over a space already outlined there is reported as a duplicate, and nothing is renumbered', () => {
    const draft = lot()
    const grid = fitGrid(draft.spaces)
    const { draft: next, note } = addSpaceFromOutline(draft, 'V1', at(2, ROW_Y.B), grid) // where B-02 is
    expect(note).toBe('B-02 is already outlined in that spot; delete one of the two')
    expect(next.spaces.find((s) => s.spaceId === 'B-02')!.label).toBe('B-02')
  })

  it('a free cell just takes its label', () => {
    const draft = lot()
    const grid = fitGrid(draft.spaces)
    const { space: added } = addSpaceFromOutline(draft, 'V1', at(5, ROW_Y.C), grid)
    expect(added).toMatchObject({ label: 'C-06', rect: cellRect(grid, { row: 2, col: 5 }) })
  })
})

describe('placeFromPhoto', () => {
  it('moves an existing space to its photo cell, renumbering the row when its label is taken', () => {
    // A space drawn below everything as H-01, outlined at the empty photo spot before row B.
    const base = lot()
    const draft = {
      ...base,
      spaces: [...base.spaces, space('h', 20, 600, { label: 'H-01', rect: { x: 20, y: 600, w: 40, h: 72 } })],
      viewpoints: [{ ...base.viewpoints[0], outlines: { ...base.viewpoints[0].outlines, h: at(0, ROW_Y.B) } }],
    }
    const grid = fitGrid(draft.spaces)
    const { draft: next } = placeFromPhoto(draft, 'V1', 'h', grid)
    expect(next.spaces.find((s) => s.spaceId === 'h')).toMatchObject({ label: 'B-01', rect: cellRect(grid, { row: 1, col: 0 }) })
    expect(next.spaces.find((s) => s.spaceId === 'B-04')!.label).toBe('B-05')
  })

  it('needs something outlined to go by', () => {
    const draft = davidFixture({ viewpoints: [{ ...davidFixture().viewpoints[0], outlines: { 'A-01': at(0, 0.1) } }] })
    expect(placeFromPhoto(draft, 'V1', 'A-01', fitGrid(draft.spaces)).note).toMatch(/Outline a few spaces/)
  })
})
