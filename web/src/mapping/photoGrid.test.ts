import { describe, expect, it } from 'vitest'
import { davidFixture, space } from './fixtures/david'
import { matchRowToPhoto, placeFromPhoto, photoCell } from './photoGrid'
import { cellRect, fitGrid } from './schematic/grid'
import { addSpaceFromOutline, followOutline } from './sync'
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
    expect(photoCell(draft, draft.viewpoints[0], at(0, ROW_Y.B))).toMatchObject({ row: 1, col: 0 })
    expect(photoCell(draft, draft.viewpoints[0], at(3, ROW_Y.C))).toMatchObject({ row: 2, col: 3 })
    // A new row below E.
    expect(photoCell(draft, draft.viewpoints[0], at(2, 0.9))).toMatchObject({ row: 5, col: 2 })
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
    expect(placeFromPhoto(draft, 'V1', 'A-01', fitGrid(draft.spaces)).note).toMatch(/Outline more spaces/)
  })
})

/** The same lot photographed from the other side: numbers run right to left and row B is at the bottom. */
function mirrored(): DraftLayout {
  const base = lot()
  const flip = (o: Outline): Outline => o.map(([x, y]) => [Number((1 - x).toFixed(4)), Number((1 - y).toFixed(4))])
  const v = base.viewpoints[0]
  return { ...base, viewpoints: [{ ...v, outlines: Object.fromEntries(Object.entries(v.outlines).map(([k, o]) => [k, flip(o)])) }] }
}

describe('photos taken from other sides', () => {
  it('reads cells the same when numbers run right to left and rows bottom to top', () => {
    const draft = mirrored()
    const flipped = (o: Outline): Outline => o.map(([x, y]) => [Number((1 - x).toFixed(4)), Number((1 - y).toFixed(4))])
    expect(photoCell(draft, draft.viewpoints[0], flipped(at(0, ROW_Y.B)))).toMatchObject({ row: 1, col: 0 })
    expect(photoCell(draft, draft.viewpoints[0], flipped(at(5, ROW_Y.C)))).toMatchObject({ row: 2, col: 5 })
    expect(photoCell(draft, draft.viewpoints[0], flipped(at(2, 0.9)))).toMatchObject({ row: 5, col: 2 })
  })

  it('a row whose outlines are scattered all over is outvoted; the other rows still read', () => {
    const base = lot()
    const v = base.viewpoints[0]
    const ys = [0.1, 0.5, 0.3, 0.7]
    const outlines = { ...v.outlines }
    ;['B-01', 'B-02', 'B-03', 'B-04'].forEach((id, i) => (outlines[id] = at(i + 1, ys[i])))
    const draft = { ...base, viewpoints: [{ ...v, outlines }] }
    expect(photoCell(draft, draft.viewpoints[0], at(3, ROW_Y.D), 'D-04')).toMatchObject({ row: 3, col: 3 })
  })
})

describe('short rows and far columns', () => {
  it('a row with one outlined space uses the lot\'s column pitch, not its own width', () => {
    const base = lot()
    // Row F has a single space, F-01, at column 0; a box 4 columns along is F-05.
    const f = space('F-01', 0, 0, { rect: { x: 20, y: 394, w: 40, h: 72 } })
    const draft = {
      ...base,
      spaces: [...base.spaces, f],
      viewpoints: [{ ...base.viewpoints[0], outlines: { ...base.viewpoints[0].outlines, 'F-01': at(0, 0.9) } }],
    }
    expect(photoCell(draft, draft.viewpoints[0], at(4, 0.9))).toMatchObject({ row: 5, col: 4 })
  })
})

describe('matchRowToPhoto', () => {
  it('counts outlines it could not number (two in one column) as clashes', () => {
    const base = lot()
    const v = base.viewpoints[0]
    // B-04 outlined over B-03's spot: two outlines in column 3.
    const draft = { ...base, viewpoints: [{ ...v, outlines: { ...v.outlines, 'B-04': at(3, ROW_Y.B) } }] }
    const { clashes } = matchRowToPhoto(draft, draft.viewpoints[0], 1, fitGrid(draft.spaces))
    expect(clashes).toBe(1)
  })
})

describe('a new space before the first column when the map has to grow left', () => {
  it('the grid moves with the shifted spaces, so the new space and its row land in their cells', () => {
    // Rows C to E have no column-1 space, and C-02 sits at the map's left edge: column 1's cell is left
    // of the map, so adding B-01 there grows the map left and shifts every space.
    const base = lot()
    const drop = new Set(['C-01', 'D-01', 'E-01'])
    const spaces = base.spaces.filter((s) => !drop.has(s.spaceId)).map((s) => ({ ...s, rect: { ...s.rect, x: s.rect.x - 65 } }))
    const outlines = Object.fromEntries(Object.entries(base.viewpoints[0].outlines).filter(([k]) => !drop.has(k)))
    const draft = { ...base, spaces, viewpoints: [{ ...base.viewpoints[0], outlines }] }
    const grid = fitGrid(draft.spaces)
    const { draft: next, space: added, dx } = addSpaceFromOutline(draft, 'V1', at(0, ROW_Y.B), grid)
    const shifted = { ...grid, x0: grid.x0 + dx }
    expect(dx).toBeGreaterThan(0)
    expect(added).toMatchObject({ label: 'B-01', rect: cellRect(shifted, { row: 1, col: 0 }) })
    expect(next.spaces.find((s) => s.spaceId === 'B-01')!.rect).toEqual(cellRect(shifted, { row: 1, col: 1 }))
    expect(next.spaces.find((s) => s.spaceId === 'C-02')!.rect.x).toBeCloseTo(cellRect(shifted, { row: 2, col: 1 }).x, 0)
  })
})

describe('photo nudges', () => {
  it('a small nudge on the photo that tips over a column boundary does not rename', () => {
    const draft = lot()
    const grid = fitGrid(draft.spaces)
    const v = draft.viewpoints[0]
    // C-03 drawn a little right of its spot (0.45 of a column), then nudged a little more (to 0.55).
    const drawn = at(2.45, ROW_Y.C)
    const before = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'C-03': drawn } }] }
    const after = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'C-03': at(2.55, ROW_Y.C) } }] }
    const res = followOutline(before, after, 'V1', 'C-03', grid, false)
    expect(res.draft.spaces.find((s) => s.spaceId === 'C-03')!.label).toBe('C-03')
  })
})

describe('a stray row', () => {
  it('a half-outlined, mislabelled row does not stop the photo being read', () => {
    const base = lot()
    // One space labelled F-01 but outlined in row C's band: row F's middle sits on top of row C.
    const f = space('F-01', 0, 0, { rect: { x: 20, y: 394, w: 40, h: 72 } })
    const draft = {
      ...base,
      spaces: [...base.spaces, f],
      viewpoints: [{ ...base.viewpoints[0], outlines: { ...base.viewpoints[0].outlines, 'F-01': at(7, ROW_Y.C + 0.01) } }],
    }
    expect(photoCell(draft, draft.viewpoints[0], at(0, ROW_Y.B))).toMatchObject({ row: 1, col: 0 })
  })
})

describe('photo moves', () => {
  it('a move of half a column or more renames; one into the label\'s own cell snaps without renaming', () => {
    const draft = lot()
    const grid = fitGrid(draft.spaces)
    const v = draft.viewpoints[0]
    const withC03 = (o: Outline) => ({ ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'C-03': o } }] })
    const moved = followOutline(draft, withC03(at(5, ROW_Y.C)), 'V1', 'C-03', grid, true).draft
    expect(moved.spaces.find((s) => s.spaceId === 'C-03')!.label).toBe('C-06')

    // C-03's box drawn in the wrong schematic cell; its outline dragged back onto column 3.
    const misdrawn = {
      ...withC03(at(6, ROW_Y.C)),
      spaces: draft.spaces.map((s) => (s.spaceId === 'C-03' ? { ...s, rect: cellRect(grid, { row: 2, col: 6 }) } : s)),
    }
    const back = followOutline(misdrawn, { ...misdrawn, viewpoints: withC03(at(2, ROW_Y.C)).viewpoints }, 'V1', 'C-03', grid, true).draft
    expect(back.spaces.find((s) => s.spaceId === 'C-03')).toMatchObject({ label: 'C-03', rect: cellRect(grid, { row: 2, col: 2 }) })
  })

  it('a small vertical nudge over the halfway line between rows does not rename', () => {
    const draft = lot()
    const grid = fitGrid(draft.spaces)
    const v = draft.viewpoints[0]
    // Rows are 0.2 apart; C-03 drawn 0.09 low, then nudged to 0.11 low.
    const before = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'C-03': at(2, ROW_Y.C + 0.09) } }] }
    const after = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'C-03': at(2, ROW_Y.C + 0.11) } }] }
    expect(followOutline(before, after, 'V1', 'C-03', grid, false).draft.spaces.find((s) => s.spaceId === 'C-03')!.label).toBe('C-03')
  })
})

describe('layout sanity', () => {
  it('a stacked pair of outlines under far-apart numbers can\'t shrink the columns to nothing', () => {
    // A two-space row R whose R-01 and R-09 are outlined on top of each other, and nothing else.
    const draft = davidFixture({
      spaces: [space('R-01', 0, 0), space('R-09', 0, 0)],
      viewpoints: [{ ...davidFixture().viewpoints[0], outlines: { 'R-01': at(0, 0.3), 'R-09': at(0.05, 0.3) }, outlineReview: {} }],
    })
    expect(photoCell(draft, draft.viewpoints[0], at(3, 0.3))).toBeNull()
  })

  it('reads a photo turned to any angle, every cell, including far corners', () => {
    // A wider lot (rows B to E, 12 columns, rows 0.12 apart), turned about the middle of the photo.
    const cols = 12
    const y0 = { B: 0.3, C: 0.42, D: 0.54, E: 0.66 } as const
    const spot = (col: number, y: number): Outline => {
      const x = 0.25 + col * 0.04
      return [
        [x, y],
        [x + 0.035, y],
        [x + 0.035, y + 0.08],
        [x, y + 0.08],
      ]
    }
    const spaces = (['B', 'C', 'D', 'E'] as const).flatMap((r) =>
      Array.from({ length: cols }, (_, i) => space(`${r}-${String(i + 1).padStart(2, '0')}`, 0, 0)),
    )
    for (const deg of [0, 3, 7, 15, 45, 90, 160]) {
      const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]
      const turn = (o: Outline): Outline => o.map(([x, y]) => [0.5 + (x - 0.5) * c - (y - 0.5) * s, 0.5 + (x - 0.5) * s + (y - 0.5) * c])
      const outlines = Object.fromEntries(
        spaces.map((sp) => [sp.spaceId, turn(spot(Number(sp.label.slice(2)) - 1, y0[sp.label[0] as keyof typeof y0]))]),
      )
      const draft = davidFixture({ spaces, viewpoints: [{ ...davidFixture().viewpoints[0], outlines, outlineReview: {} }] })
      const read = spaces.map((sp) => {
        const cell = photoCell(draft, draft.viewpoints[0], outlines[sp.spaceId], sp.spaceId)
        return cell && `${'ABCDEFGH'[cell.row]}-${String(cell.col + 1).padStart(2, '0')}`
      })
      expect(read, `${deg} degrees`).toEqual(spaces.map((sp) => sp.label))
      // A new space past the end of row C.
      expect(photoCell(draft, draft.viewpoints[0], turn(spot(cols, y0.C))), `${deg} degrees`).toMatchObject({ row: 2, col: cols })
    }
  })

  it('one stray outline in a small lot does not stop the photo being read', () => {
    // Two rows only; C-03 outlined a whole row low.
    const spaces = [1, 2, 3, 4, 5, 6].flatMap((n) => [space(`B-0${n}`, 0, 0), space(`C-0${n}`, 0, 0)])
    const outlines = Object.fromEntries(
      spaces.map((s) => [s.spaceId, at(Number(s.label.slice(2)) - 1, s.label === 'C-03' ? 0.5 : s.label[0] === 'B' ? 0.1 : 0.3)]),
    )
    const draft = davidFixture({ spaces, viewpoints: [{ ...davidFixture().viewpoints[0], outlines, outlineReview: {} }] })
    expect(photoCell(draft, draft.viewpoints[0], at(6, 0.3))).toMatchObject({ row: 2, col: 6 })
  })

  it('a sideways drag across a column, ending a hair over a row boundary, keeps the row', () => {
    const draft = lot()
    const grid = fitGrid(draft.spaces)
    const v = draft.viewpoints[0]
    const before = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'C-03': at(2, ROW_Y.C + 0.098) } }] }
    const after = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'C-03': at(5, ROW_Y.C + 0.102) } }] }
    const c03 = followOutline(before, after, 'V1', 'C-03', grid, false).draft.spaces.find((s) => s.spaceId === 'C-03')!
    expect(c03.label).toBe('C-06')
  })
})
