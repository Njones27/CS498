import { describe, expect, it } from 'vitest'
import { davidFixture, space } from '../fixtures/david'
import {
  arrangeByLabels,
  cellAt,
  cellLabel,
  cellRect,
  cellsIn,
  cellTaken,
  fitGrid,
  gridInView,
  gridSizes,
  labelDigits,
  relabelForCell,
  rowIndex,
  rowLetter,
  snapMove,
  snapResize,
  type Grid,
} from './grid'

/** Rows B..D at pitch 90 (box 72 tall), columns at pitch 45 (box 40 wide), starting at x 32, y 34. */
function lotSpaces() {
  return ['B', 'C', 'D'].flatMap((row, r) =>
    [1, 2, 3, 4, 5].map((n) =>
      space(`${row}-0${n}`, 32 + (n - 1) * 45, 34 + r * 90, { rect: { x: 32 + (n - 1) * 45, y: 34 + r * 90, w: 40, h: 72 } }),
    ),
  )
}

const G: Grid = { x0: 30, y0: -65, cellW: 45, cellH: 90, boxW: 40, boxH: 72 }

describe('row letters', () => {
  it('runs A..Z then AA, and back', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(rowLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA'])
    expect(['A', 'b', 'Z', 'AA', 'BA'].map(rowIndex)).toEqual([0, 1, 25, 26, 52])
    expect(rowLetter(-1)).toBeNull()
  })
})

describe('fitGrid', () => {
  it('reads the pitch, box size and origin off the labels, so row B is grid row B', () => {
    const g = fitGrid(lotSpaces())
    expect(g).toEqual({ x0: 29.5, y0: -65, cellW: 45, cellH: 90, boxW: 40, boxH: 72 })
    expect(cellRect(g, { row: 1, col: 0 })).toEqual({ x: 32, y: 34, w: 40, h: 72 }) // B-01 where it is
    expect(cellRect(g, { row: 3, col: 4 })).toEqual({ x: 212, y: 214, w: 40, h: 72 }) // D-05
  })

  it('ignores a misplaced space and takes size overrides', () => {
    const spaces = [...lotSpaces(), space('B-09', 0, 500, { rect: { x: 0, y: 500, w: 40, h: 72 } })]
    expect(fitGrid(spaces).cellW).toBe(45)
    const g = fitGrid(lotSpaces(), { boxW: 50, gapX: 10 })
    expect([g.boxW, g.cellW, g.boxH, g.cellH]).toEqual([50, 60, 72, 90])
    expect(gridSizes(g)).toEqual({ boxW: 50, boxH: 72, gapX: 10, gapY: 18 })
  })

  it('falls back to the default size at the margin with no labels', () => {
    const g = fitGrid([space('g', 0, 0, { label: 'Gate' })])
    expect(cellRect(g, { row: 0, col: 0 })).toMatchObject({ x: 20, y: 20, w: 100, h: 120 })
  })
})

describe('cells', () => {
  it('finds the cell under a point and labels it', () => {
    expect(cellAt(G, [80, 130])).toEqual({ row: 2, col: 1 })
    expect(cellLabel({ row: 2, col: 6 })).toBe('C-07')
    expect(cellLabel({ row: 2, col: 6 }, 3)).toBe('C-007')
    expect(cellLabel({ row: -1, col: 0 })).toBeNull()
    expect(cellLabel({ row: 0, col: -1 })).toBeNull()
  })

  it('snaps a move into the cell under its middle', () => {
    expect(snapMove(G, { x: 70, y: 120, w: 30, h: 50 })).toEqual({ rect: { x: 77.5, y: 124, w: 40, h: 72 }, cell: { row: 2, col: 1 } })
  })

  it('snaps resized edges onto box edges and keeps the others', () => {
    const r = { x: 32.5, y: 34, w: 40, h: 72 }
    expect(snapResize(G, { ...r, w: 80 }, 'se')).toEqual({ x: 32.5, y: 34, w: 85, h: 72 }) // now two cells wide
    expect(snapResize(G, { x: 20, y: 10, w: 52.5, h: 96 }, 'nw')).toEqual({ x: 32.5, y: 34, w: 40, h: 72 })
  })

  it('lists the cells a drawn box covers, with a cap', () => {
    expect(cellsIn(G, [40, 40], [130, 60])).toEqual([
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ])
    expect(cellsIn(G, [0, 0], [100000, 1000])).toEqual([])
  })

  it('a cell is taken by a space in it or by its label elsewhere', () => {
    const spaces = [space('B-01', 32, 34, { rect: { x: 32, y: 34, w: 40, h: 72 } }), space('x', 500, 500, { label: 'B-03' })]
    expect(cellTaken(G, spaces, { row: 1, col: 0 }, 'B-01')).toBe(true)
    expect(cellTaken(G, spaces, { row: 1, col: 0 }, 'B-01', 'B-01')).toBe(false)
    expect(cellTaken(G, spaces, { row: 1, col: 2 }, 'B-03')).toBe(true)
    expect(cellTaken(G, spaces, { row: 1, col: 1 }, 'B-02')).toBe(false)
  })
})

describe('relabel by cell', () => {
  const spaces = [space('a', 0, 0, { label: 'B-01' }), space('b', 0, 0, { label: 'C-07' }), space('g', 0, 0, { label: 'Gate' })]

  it('takes the cell label when free', () => {
    expect(relabelForCell(spaces, 'a', { row: 3, col: 4 })).toEqual({ label: 'D-05' })
  })
  it('keeps the label when another space uses it, or the cell is outside the rows', () => {
    expect(relabelForCell(spaces, 'a', { row: 2, col: 6 })).toEqual({ note: 'C-07 is already used; kept B-01' })
    expect(relabelForCell(spaces, 'a', { row: -1, col: 0 }).note).toMatch(/Outside the lettered rows/)
  })
  it('never renames a custom name', () => {
    expect(relabelForCell(spaces, 'g', { row: 3, col: 4 })).toEqual({})
  })
})

describe('arrangeByLabels', () => {
  it('puts every labeled space in its cell at the grid size', () => {
    const draft = davidFixture() // A-01..A-05 at pitch 110, box 100 x 120; A-05 retired
    const g = { ...G, y0: 0 }
    const { draft: next, spaceIds } = arrangeByLabels(draft, g)
    expect(next.spaces.find((s) => s.spaceId === 'A-03')!.rect).toEqual(cellRect(g, { row: 0, col: 2 }))
    expect(spaceIds).not.toContain('A-05')
    expect(next.spaces.find((s) => s.spaceId === 'A-05')!.rect).toEqual(draft.spaces[4].rect)
  })
})

describe('gridInView', () => {
  it('lists boundaries and labeled cells in view, nothing when too dense', () => {
    const v = gridInView(G, { x: 0, y: 0, w: 100, h: 200 })
    expect(v.xs).toEqual([30, 75])
    expect(v.ys).toEqual([25, 115])
    expect(v.cols).toEqual([-1, 0, 1]) // cell middles at 7.5, 52.5, 97.5
    expect(v.rows).toEqual([1, 2]) // middles at 70, 160
    expect(gridInView(G, { x: 0, y: 0, w: 100000, h: 10 }).xs).toEqual([])
  })
})

describe('labelDigits', () => {
  it('uses the lot\'s most common label width, at least 2', () => {
    expect(labelDigits([space('a', 0, 0, { label: 'A-001' }), space('b', 0, 0, { label: 'A-002' }), space('c', 0, 0, { label: 'B-01' })])).toBe(3)
    expect(labelDigits([space('a', 0, 0, { label: 'A1' })])).toBe(2)
    expect(labelDigits([])).toBe(2)
  })
})
