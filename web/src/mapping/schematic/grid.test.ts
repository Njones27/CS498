import { describe, expect, it } from 'vitest'
import { davidFixture, space } from '../fixtures/david'
import {
  alignToCells,
  anchorGrid,
  cellAt,
  cellLabel,
  cellRect,
  cellsIn,
  cellTaken,
  fitGrid,
  gridInView,
  insertAtRowStart,
  gridSizes,
  labelDigits,
  relabelMoved,
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
  // G: column c's box starts at x 32.5 + 45c, row r's at y -56 + 90r (row B at 34).
  const at = (id: string, label: string, row: number, col: number) =>
    space(id, 0, 0, { label, rect: cellRect(G, { row, col }) })

  it('takes the cell label when free', () => {
    const spaces = [at('a', 'B-01', 1, 0)]
    expect([...relabelMoved(G, spaces, 'a', { row: 3, col: 4 }).labels]).toEqual([['a', 'D-05']])
  })

  it('renames a space elsewhere that had the label, for the cell it sits in', () => {
    // 'm' is labeled C-07 but sits in C-09's cell.
    const spaces = [at('a', 'B-01', 1, 0), at('m', 'C-07', 2, 8)]
    const { labels, note } = relabelMoved(G, spaces, 'a', { row: 2, col: 6 })
    expect([...labels]).toEqual([
      ['a', 'C-07'],
      ['m', 'C-09'],
    ])
    expect(note).toBe('Now C-07; the space that was C-07 is now C-09')
  })

  it('leaves a duplicate (flagged) when the other space\'s own cell label is taken too', () => {
    const spaces = [at('a', 'B-01', 1, 0), at('m', 'C-07', 2, 8), at('n', 'C-09', 3, 3)]
    const { labels, note } = relabelMoved(G, spaces, 'a', { row: 2, col: 6 })
    expect([...labels]).toEqual([['a', 'C-07']])
    expect(note).toMatch(/another space is also C-07/)
  })

  it('never gives two other spaces the same new label', () => {
    // Two spaces both labeled C-07, stacked in C-09's cell.
    const spaces = [at('a', 'B-01', 1, 0), at('m', 'C-07', 2, 8), at('n', 'C-07', 2, 8)]
    const { labels, note } = relabelMoved(G, spaces, 'a', { row: 2, col: 6 })
    expect([...labels]).toEqual([
      ['a', 'C-07'],
      ['m', 'C-09'],
    ])
    expect(note).toMatch(/another space is also C-07/)
  })

  it('keeps names and cells outside the lettered rows', () => {
    const spaces = [at('g', 'Gate', 1, 0), at('a', 'B-01', 1, 1)]
    expect(relabelMoved(G, spaces, 'g', { row: 3, col: 4 }).labels.size).toBe(0)
    expect(relabelMoved(G, spaces, 'a', { row: -1, col: 0 }).note).toMatch(/Outside the lettered rows/)
  })
})

describe('alignToCells', () => {
  it('snaps every space into the cell it is in and names it for that cell, without moving it far', () => {
    // A-01..A-04 at pitch 110 with G's 45 pitch: each lands in the cell under its middle.
    const draft = davidFixture()
    const { draft: next, moved, renamed } = alignToCells(draft, G)
    const a03 = next.spaces.find((s) => s.spaceId === 'A-03')!
    const cell = cellAt(G, [260 + 50, 40 + 60]) // where A-03 already was
    expect(a03.rect).toEqual(cellRect(G, cell))
    expect(a03.label).toBe('B-07')
    expect(moved).toBe(4)
    expect(renamed).toBe(4)
    expect(next.spaces.find((s) => s.spaceId === 'A-05')).toEqual(draft.spaces[4]) // retired: untouched
  })

  it('gives a space whose cell is taken the nearest free cell, and keeps names', () => {
    const spaces = [
      space('p', 32, 34, { label: 'B-01', rect: { x: 32, y: 34, w: 40, h: 72 } }),
      space('q', 40, 34, { label: 'X-09', rect: { x: 40, y: 34, w: 40, h: 72 } }), // same cell as p
      space('g', 300, 34, { label: 'Gate', rect: { x: 300, y: 34, w: 40, h: 72 } }),
    ]
    const { draft: next } = alignToCells(davidFixture({ spaces }), G)
    expect(next.spaces.map((s) => [s.label, s.rect.x])).toEqual([
      ['B-01', 32.5],
      ['B-02', 77.5],
      ['Gate', cellRect(G, cellAt(G, [320, 70])).x],
    ])
  })

  it('never hands out a label another space keeps, even down a chain', () => {
    const at = (id: string, label: string, row: number, col: number) =>
      space(id, 0, 0, { label, rect: cellRect(G, { row, col }) })
    const spaces = [
      at('keep', 'A-05', -1, 4), // above row A: keeps A-05
      at('s', 'B-09', 0, 4), // in A-05's cell, but A-05 is kept: keeps B-09
      at('s3', 'Z-01', 1, 8), // in B-09's cell, but B-09 is now kept: keeps Z-01
    ]
    const labels = alignToCells(davidFixture({ spaces }), G).draft.spaces.map((x) => x.label)
    expect(labels).toEqual(['A-05', 'B-09', 'Z-01'])
  })

  it('goes row by row, then left to right, even when a row is a little uneven', () => {
    // q is left of p but sits a little lower; both are in row B and want p's cell.
    const spaces = [
      space('p', 0, 0, { label: 'B-01', rect: { x: 36, y: 34, w: 40, h: 72 } }),
      space('q', 0, 0, { label: 'X-01', rect: { x: 31, y: 40, w: 40, h: 72 } }),
    ]
    const next = alignToCells(davidFixture({ spaces }), G).draft.spaces
    expect(next.map((x) => x.label)).toEqual(['B-02', 'B-01']) // q, further left, takes column 1
  })

  it('relabelMoved may hand out a retired space\'s label, as the server allows', () => {
    const at = (id: string, label: string, row: number, col: number, retired = false) =>
      space(id, 0, 0, { label, retired, rect: cellRect(G, { row, col }) })
    const spaces = [at('a', 'B-01', 1, 0), at('m', 'C-07', 2, 8), at('r', 'C-09', 4, 4, true)]
    expect([...relabelMoved(G, spaces, 'a', { row: 2, col: 6 }).labels]).toEqual([
      ['a', 'C-07'],
      ['m', 'C-09'],
    ])
  })

  it('leaves a draft already on the grid alone', () => {
    const draft = davidFixture({ spaces: [space('B-01', 0, 0, { rect: cellRect(G, { row: 1, col: 0 }) })] })
    expect(alignToCells(draft, G).draft).toBe(draft)
  })
})

describe('anchorGrid', () => {
  it('goes by where the space sits when its label points far away', () => {
    const rect = { x: 100, y: 120, w: 50, h: 80 }
    const g = anchorGrid(G, rect, 'Z-40')
    expect(cellAt(g, [125, 160])).toEqual(cellAt(G, [125, 160]))
  })

  it('puts a labeled space in its label\'s cell', () => {
    const rect = { x: 100, y: 120, w: 50, h: 80 }
    // It sits in C-03's cell; labeled C-04 (one column off), it goes into C-04's.
    const g = anchorGrid(G, rect, 'C-04')
    expect(cellAt(g, [125, 160])).toEqual({ row: 2, col: 3 })
    expect(cellRect(g, { row: 2, col: 3 })).toEqual(rect)
  })

  it('lines the grid up with one space: it fills its cell exactly and the gaps stay', () => {
    const rect = { x: 100, y: 120, w: 50, h: 80 }
    const g = anchorGrid(G, rect)
    expect([g.boxW, g.boxH, g.cellW - g.boxW, g.cellH - g.boxH]).toEqual([50, 80, 5, 18])
    expect(cellRect(g, cellAt(g, [125, 160]))).toEqual(rect)
    expect(cellAt(g, [125, 160])).toEqual(cellAt(G, [125, 160])) // same row and column as before
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

describe('insertAtRowStart', () => {
  const at = (id: string, label: string, row: number, col: number) => space(id, 0, 0, { label, rect: cellRect(G, { row, col }) })

  it('a space from another row becomes 01 and the whole row moves up one', () => {
    const draft = davidFixture({ spaces: [at('x', 'D-07', 3, 6), at('a', 'B-01', 1, 0), at('b', 'B-02', 1, 1)] })
    const next = insertAtRowStart(draft, G, 'x', 1)!
    expect(next.spaces.map((s) => [s.label, s.rect.x])).toEqual([
      ['B-01', cellRect(G, { row: 1, col: 0 }).x],
      ['B-02', cellRect(G, { row: 1, col: 1 }).x],
      ['B-03', cellRect(G, { row: 1, col: 2 }).x],
    ])
  })

  it('a space of the same row moves only those numbered below it', () => {
    const draft = davidFixture({ spaces: [at('a', 'B-01', 1, 0), at('b', 'B-02', 1, 1), at('c', 'B-03', 1, 2), at('d', 'B-04', 1, 3)] })
    const next = insertAtRowStart(draft, G, 'c', 1)!
    expect(next.spaces.map((s) => s.label)).toEqual(['B-02', 'B-03', 'B-01', 'B-04'])
  })

  it('refuses when a space that is not numbered sits where the row would move', () => {
    const draft = davidFixture({ spaces: [at('x', 'D-07', 3, 6), at('a', 'B-01', 1, 0), at('g', 'Gate', 1, 1)] })
    expect(insertAtRowStart(draft, G, 'x', 1)).toBeNull()
    expect(insertAtRowStart(draft, G, 'x', -1)).toBeNull() // above row A
  })
})
