import { describe, expect, it } from 'vitest'
import { davidFixture, space } from './fixtures/david'
import { fitSchematic } from './schematic/edits'
import { labelForRect } from './schematic/labels'
import { cellRect, fitGrid } from './schematic/grid'
import { isValidQuad } from './photo/geom'
import {
  addSpaceFromOutline,
  addSpaceOnSchematic,
  afterRectChange,
  applyMat,
  dropPendingProposals,
  fitTransform,
  invert,
  photoToSchematic,
  proposeOutlines,
  rectToOutline,
  followOutline,
  followRects,
  addSpacesInCells,
  suggestOutline,
  type Mat3,
} from './sync'
import type { DraftLayout, DraftRect, Outline, Point } from './types'

// A mild perspective: schematic units -> photo fractions.
const TRUE_TO_PHOTO: Mat3 = [0.0008, 0.0001, 0.05, 0.00005, 0.0012, 0.1, 0.00002, 0.00003, 1]

const project = (m: Mat3, p: Point): Point => {
  const q = applyMat(m, p)!
  return [Number(q[0].toFixed(4)), Number(q[1].toFixed(4))]
}
/** B-02's (or any) outline slid on the photo, keeping its photo size, so its middle lands where `to`'s would. */
const slideTo = (outline: Outline, to: DraftRect): Outline => {
  const mid = (o: Outline) => [o.reduce((t, p) => t + p[0], 0) / 4, o.reduce((t, p) => t + p[1], 0) / 4]
  const [ax, ay] = mid(outline)
  const [bx, by] = mid(outlineOf(to))
  return outline.map(([x, y]) => [Number((x + bx - ax).toFixed(4)), Number((y + by - ay).toFixed(4))] as Point)
}

const outlineOf = (r: DraftRect): Outline =>
  [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ].map((p) => project(TRUE_TO_PHOTO, p as Point))

/** Rows A and B, four spaces each, every one outlined in V1 through TRUE_TO_PHOTO. */
function gridDraft(): DraftLayout {
  const spaces = ['A', 'B'].flatMap((row, r) =>
    [1, 2, 3, 4].map((n) => space(`${row}-0${n}`, 40 + (n - 1) * 110, 40 + r * 200)),
  )
  return davidFixture({
    spaces,
    viewpoints: [
      {
        ...davidFixture().viewpoints[0],
        outlines: Object.fromEntries(spaces.map((s) => [s.spaceId, outlineOf(s.rect)])),
        outlineReview: Object.fromEntries(spaces.map((s) => [s.spaceId, { source: 'drawn', status: 'accepted' }])),
      },
    ],
  })
}

describe('fitTransform', () => {
  it('recovers a perspective map from point pairs', () => {
    const src: Point[] = [
      [0, 0],
      [500, 0],
      [500, 400],
      [0, 400],
      [250, 200],
      [100, 300],
    ]
    const m = fitTransform(src, src.map((p) => applyMat(TRUE_TO_PHOTO, p)!))!
    const q = applyMat(m, [321, 123])!
    const want = applyMat(TRUE_TO_PHOTO, [321, 123])!
    expect(q[0]).toBeCloseTo(want[0], 6)
    expect(q[1]).toBeCloseTo(want[1], 6)
    const back = applyMat(invert(m)!, want)!
    expect(back[0]).toBeCloseTo(321, 3)
  })

  it('needs four points not all on one line', () => {
    expect(fitTransform([[0, 0], [1, 1], [2, 2]], [[0, 0], [1, 1], [2, 2]])).toBeNull()
    const line: Point[] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]
    expect(fitTransform(line, line)).toBeNull()
  })
})

describe('photo <-> schematic sync', () => {
  it('a box drawn on the photo lands at the matching spot in the schematic, labeled for its row', () => {
    const draft = gridDraft()
    const target = { x: 480, y: 240, w: 100, h: 120 } // right of B-04
    const { draft: next, space: added } = addSpaceFromOutline(draft, 'V1', outlineOf(target))
    expect(added.label).toBe('B-05')
    expect(added.rect.x).toBeCloseTo(480, -1)
    expect(added.rect.y).toBeCloseTo(240, -1)
    expect(added.rect.w).toBeGreaterThan(80)
    expect(next.viewpoints[0].outlines[added.spaceId]).toEqual(outlineOf(target))
    expect(next.viewpoints[0].outlineReview[added.spaceId]).toEqual({ source: 'drawn', status: 'accepted' })
    expect(draft.spaces).toHaveLength(8) // input untouched
  })

  it('a box drawn a little over its neighbour is nudged clear of it on the schematic', () => {
    const draft = gridDraft()
    const { space: added } = addSpaceFromOutline(draft, 'V1', outlineOf({ x: 420, y: 245, w: 100, h: 110 })) // B-04 ends at 470
    expect(added.label).toBe('B-05')
    expect(added.rect.x).toBeGreaterThanOrEqual(480)
    expect(added.rect.y).toBeCloseTo(245, -1)
  })

  it('a box above every row starts a new row and grows the map upward', () => {
    const draft = gridDraft()
    const { draft: next, space: added } = addSpaceFromOutline(draft, 'V1', outlineOf({ x: 40, y: -150, w: 100, h: 120 }))
    expect(added.label).toBe('C-01')
    expect(added.rect.y).toBeGreaterThanOrEqual(0)
    expect(next.schematic.height).toBeGreaterThan(600)
    const a1 = next.spaces.find((s) => s.spaceId === 'A-01')!
    expect(a1.rect.y).toBeGreaterThan(40) // everything shifted down to make room
  })

  it('without enough outlines to fit, the new space goes right of the nearest outlined row', () => {
    const draft = davidFixture() // only A-01 is outlined (A-05 is retired)
    const { space: added } = addSpaceFromOutline(draft, 'V1', [
      [0.2, 0.2],
      [0.28, 0.2],
      [0.28, 0.31],
      [0.2, 0.31],
    ])
    expect(added.label).toBe('A-06')
  })

  it('a space added on the schematic gets a pending proposed outline on the photo', () => {
    const draft = gridDraft()
    const rect = { x: 480, y: 40, w: 100, h: 120 }
    const { draft: next, space: added } = addSpaceOnSchematic(draft, rect)
    expect(added.label).toBe('A-05')
    const outline = next.viewpoints[0].outlines[added.spaceId]
    expect(next.viewpoints[0].outlineReview[added.spaceId]).toEqual({ source: 'proposed', status: 'pending' })
    outline.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(outlineOf(rect)[i][0], 3)
      expect(p[1]).toBeCloseTo(outlineOf(rect)[i][1], 3)
    })
  })

  it('proposals skip spaces already outlined, retired spaces and spaces off the photo', () => {
    const draft = gridDraft()
    expect(proposeOutlines(draft, ['A-01'])).toBe(draft)
    const off = { ...draft, spaces: [...draft.spaces, space('far', 90000, 90000)] }
    expect(proposeOutlines(off, ['far'])).toBe(off)
  })

  it('moving or resizing a space on the schematic moves and resizes its outlines on the photo', () => {
    const { draft, space: added } = addSpaceOnSchematic(gridDraft(), { x: 480, y: 40, w: 100, h: 120 })
    const moved = {
      ...draft,
      spaces: draft.spaces.map((s) =>
        s.spaceId === added.spaceId
          ? { ...s, rect: { ...s.rect, x: s.rect.x + 30 } }
          : s.spaceId === 'A-01'
            ? { ...s, rect: { x: 40, y: 40, w: 200, h: 120 } }
            : s,
      ),
    }
    const next = followRects(draft, moved, [added.spaceId, 'A-01'])
    const v = next.viewpoints[0]
    // The pending proposal lands where the new rect projects; the accepted outline is stretched to match.
    expect(v.outlines[added.spaceId][0][0]).toBeCloseTo(outlineOf({ x: 510, y: 40, w: 100, h: 120 })[0][0], 3)
    expect(v.outlines['A-01'][1][0]).toBeCloseTo(outlineOf({ x: 40, y: 40, w: 200, h: 120 })[1][0], 3)
    expect(v.outlineReview['A-01']).toEqual({ source: 'drawn', status: 'accepted' })
  })

  it('an outline keeps its own shape and offset from the rect when the rect moves', () => {
    const draft = gridDraft()
    const v = draft.viewpoints[0]
    const nudged = outlineOf({ x: 45, y: 45, w: 90, h: 110 }) // drawn a little inside A-01's rect
    const before = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'A-01': nudged } }] }
    const after = { ...before, spaces: before.spaces.map((s) => (s.spaceId === 'A-01' ? { ...s, rect: { ...s.rect, y: 140 } } : s)) }
    const out = followRects(before, after, ['A-01']).viewpoints[0].outlines['A-01']
    outlineOf({ x: 45, y: 145, w: 90, h: 110 }).forEach((p, i) => {
      expect(out[i][0]).toBeCloseTo(p[0], 2)
      expect(out[i][1]).toBeCloseTo(p[1], 2)
    })
  })

  it('moving an outline on the photo moves the rect on the schematic, and the other photos follow', () => {
    const draft = gridDraft()
    const v = draft.viewpoints[0]
    const other = { ...v, viewId: 'V2', name: 'Other' }
    const before = { ...draft, viewpoints: [v, other] }
    const after = {
      ...before,
      viewpoints: [{ ...v, outlines: { ...v.outlines, 'B-02': outlineOf({ x: 170, y: 270, w: 100, h: 120 }) } }, other],
    }
    const { draft: next } = followOutline(before, after, 'V1', 'B-02', null)
    const rect = next.spaces.find((s) => s.spaceId === 'B-02')!.rect
    expect(rect.x).toBeCloseTo(170, 0)
    expect(rect.y).toBeCloseTo(270, 0)
    expect(next.viewpoints[1].outlines['B-02'][0][0]).toBeCloseTo(outlineOf({ x: 170, y: 270, w: 100, h: 120 })[0][0], 3)
  })

  it('with snapping, a photo tweak inside the cell leaves the schematic alone; a move to another cell relabels', () => {
    const draft = gridDraft()
    const grid = fitGrid(draft.spaces)
    const v = draft.viewpoints[0]
    const withOutline = (r: DraftRect) => ({ ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'B-02': slideTo(v.outlines['B-02'], r) } }] })
    expect(followOutline(draft, withOutline({ x: 155, y: 245, w: 100, h: 120 }), 'V1', 'B-02', grid).draft.spaces).toBe(
      draft.spaces,
    )
    const { draft: moved } = followOutline(draft, withOutline({ x: 480, y: 240, w: 100, h: 120 }), 'V1', 'B-02', grid)
    expect(moved.spaces.find((s) => s.spaceId === 'B-02')).toMatchObject({ label: 'B-05', rect: cellRect(grid, { row: 1, col: 4 }) })
  })

  it('resizing one side of an outline moves only that side of the rect', () => {
    const draft = gridDraft()
    const v = draft.viewpoints[0]
    const after = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'B-02': outlineOf({ x: 150, y: 240, w: 100, h: 160 }) } }] }
    const rect = followOutline(draft, after, 'V1', 'B-02', null).draft.spaces.find((s) => s.spaceId === 'B-02')!.rect
    expect(rect.x).toBeCloseTo(150, 0)
    expect(rect.y).toBeCloseTo(240, 0)
    expect(rect.w).toBeCloseTo(100, 0)
    expect(rect.h).toBeCloseTo(160, 0)
  })

  it('an accepted outline stays put when its space moves off the photo; a pending one is dropped', () => {
    const { draft, space: added } = addSpaceOnSchematic(gridDraft(), { x: 480, y: 40, w: 100, h: 120 })
    const away = {
      ...draft,
      spaces: draft.spaces.map((s) =>
        s.spaceId === added.spaceId || s.spaceId === 'A-01' ? { ...s, rect: { ...s.rect, x: 5000, y: 5000 } } : s,
      ),
    }
    const v = followRects(draft, away, [added.spaceId, 'A-01']).viewpoints[0]
    expect(v.outlines['A-01']).toBe(draft.viewpoints[0].outlines['A-01'])
    expect(v.outlines).not.toHaveProperty(added.spaceId)
  })

  it('with snapping, a photo move onto a cell that has a space leaves the schematic alone', () => {
    const draft = gridDraft()
    const grid = fitGrid(draft.spaces)
    const v = draft.viewpoints[0]
    const after = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'B-02': outlineOf({ x: 260, y: 240, w: 100, h: 120 }) } }] }
    const res = followOutline(draft, after, 'V1', 'B-02', grid)
    expect(res.draft).toBe(after)
    expect(res.note).toMatch(/already has a space/)
  })

  it('with snapping off, a photo move into another cell moves the rect freely and renames it', () => {
    const draft = gridDraft()
    const grid = fitGrid(draft.spaces)
    const v = draft.viewpoints[0]
    const after = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'B-02': slideTo(v.outlines['B-02'], { x: 485, y: 245, w: 100, h: 120 }) } }] }
    const { draft: next, note } = followOutline(draft, after, 'V1', 'B-02', grid, false)
    const b02 = next.spaces.find((s) => s.spaceId === 'B-02')!
    expect(b02.label).toBe('B-05')
    expect(b02.rect.x).toBeCloseTo(485, -1)
    expect(b02.rect.w).toBe(100) // a move keeps the size
    expect(note).toBe('Now B-05')
  })

  it('reshaping an outline on the photo resizes the rect without renaming; with snapping the schematic stays', () => {
    const draft = gridDraft()
    const grid = fitGrid(draft.spaces)
    const v = draft.viewpoints[0]
    // B-02's outline stretched far to the right: its middle crosses into another cell.
    const after = { ...draft, viewpoints: [{ ...v, outlines: { ...v.outlines, 'B-02': outlineOf({ x: 150, y: 240, w: 300, h: 120 }) } }] }
    const free = followOutline(draft, after, 'V1', 'B-02', grid, false).draft.spaces.find((s) => s.spaceId === 'B-02')!
    expect(free.label).toBe('B-02')
    expect(free.rect.w).toBeCloseTo(300, 0)
    expect(followOutline(draft, after, 'V1', 'B-02', grid, true).draft).toBe(after)
  })

  it('under a strong perspective, moving an outline on the photo still counts as a move', () => {
    // Rows A and B (five spaces each, 120 apart) seen through a steep perspective.
    const STEEP: Mat3 = [0.0008, 0, 0.05, 0, 0.0012, 0.1, 0, 0.0015, 1]
    const steep = (r: DraftRect): Outline =>
      [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x + r.w, r.y + r.h],
        [r.x, r.y + r.h],
      ].map((p) => project(STEEP, p as Point))
    const spaces = ['A', 'B'].flatMap((row, r) => [1, 2, 3, 4, 5].map((n) => space(`${row}-0${n}`, 40 + (n - 1) * 110, 40 + r * 130)))
    const draft = davidFixture({
      spaces,
      viewpoints: [
        {
          ...davidFixture().viewpoints[0],
          outlines: Object.fromEntries(spaces.map((s) => [s.spaceId, steep(s.rect)])),
          outlineReview: {},
        },
      ],
    })
    const grid = fitGrid(draft.spaces)
    // A-02's outline slid straight down on the photo, by the photo height of a row.
    const old = draft.viewpoints[0].outlines['A-02']
    const dy = steep(spaces[6].rect)[0][1] - old[0][1]
    const slid = old.map(([x, y]) => [x, Number((y + dy).toFixed(4))] as Point)
    const after = { ...draft, viewpoints: [{ ...draft.viewpoints[0], outlines: { ...draft.viewpoints[0].outlines, 'A-02': slid } }] }
    const { draft: next } = followOutline(draft, after, 'V1', 'A-02', grid, false)
    const a02 = next.spaces.find((s) => s.spaceId === 'A-02')!
    expect(a02.rect.w).toBe(100) // a move keeps the size
    expect(a02.label).toBe('B-02')
  })

  it('a first outline does not move the space', () => {
    const draft = gridDraft()
    const v = draft.viewpoints[0]
    const { 'B-02': _, ...rest } = v.outlines
    const before = { ...draft, viewpoints: [{ ...v, outlines: rest }] }
    expect(followOutline(before, draft, 'V1', 'B-02', null).draft).toBe(draft)
  })

  it('a box drawn on the photo with snapping fills its cell and is named for it', () => {
    const draft = gridDraft()
    const grid = fitGrid(draft.spaces)
    const { space: added } = addSpaceFromOutline(draft, 'V1', outlineOf({ x: 485, y: 250, w: 90, h: 100 }), grid)
    expect(added).toMatchObject({ label: 'B-05', rect: cellRect(grid, { row: 1, col: 4 }) })
  })

  it('a box across cells on the schematic adds one space per free cell', () => {
    const draft = gridDraft()
    const grid = fitGrid(draft.spaces)
    const cells = [3, 4, 5].map((col) => ({ row: 1, col })) // B-04 (taken), B-05, B-06
    const { draft: next, spaces } = addSpacesInCells(draft, grid, cells)
    expect(spaces.map((s) => s.label)).toEqual(['B-05', 'B-06'])
    expect(next.viewpoints[0].outlineReview[spaces[0].spaceId]).toEqual({ source: 'proposed', status: 'pending' })
  })

  it('retiring a space drops its pending proposal', () => {
    const { draft, space: added } = addSpaceOnSchematic(gridDraft(), { x: 480, y: 40, w: 100, h: 120 })
    const next = dropPendingProposals(draft, [added.spaceId, 'A-01'])
    expect(next.viewpoints[0].outlines).not.toHaveProperty(added.spaceId)
    expect(next.viewpoints[0].outlineReview).not.toHaveProperty(added.spaceId)
    expect(next.viewpoints[0].outlines).toHaveProperty('A-01') // accepted outlines stay
  })

  it('one row of hand-drawn outlines (not quite on a line) still fits, on corners', () => {
    // Five spaces in one row; outline tops jitter, so their centres are nearly but not exactly in line.
    const spaces = [0, 1, 2, 3, 4].map((i) => space(`A-0${i + 1}`, 20 + i * 110, 20))
    const jitter = [0, 0.003, -0.002, 0.003, -0.001]
    const outlines = Object.fromEntries(
      spaces.map((s, i) => [s.spaceId, outlineOf(s.rect).map(([x, y], k) => [x, k < 2 ? y + jitter[i] : y] as Point)]),
    )
    const draft = davidFixture({ spaces, viewpoints: [{ ...davidFixture().viewpoints[0], outlines, outlineReview: {} }] })
    const m = photoToSchematic(draft, draft.viewpoints[0])!
    expect(invert(m)).not.toBeNull()
    const { space: added } = addSpaceFromOutline(draft, 'V1', outlineOf({ x: 570, y: 20, w: 100, h: 120 }))
    expect(added.rect.h).toBeGreaterThan(90) // a real space, not squashed onto one line
    expect(added.label).toBe('A-06')
  })

  it('a box mapped far off the map (towards the horizon) is placed by its row instead', () => {
    const draft = gridDraft()
    // Huge, far right of the photo's fitted area: mapped through the perspective it would be enormous.
    const { draft: next, space: added } = addSpaceFromOutline(draft, 'V1', [
      [0.05, 0.9],
      [0.99, 0.9],
      [0.99, 0.99],
      [0.05, 0.99],
    ])
    expect(added.rect.w).toBe(100)
    expect(next.schematic.width).toBeLessThanOrEqual(1100)
  })

  it('a projected outline pulled onto the photo edge is dropped when it folds', () => {
    const draft = gridDraft()
    // Mostly off the bottom-right of the photo, with its middle just inside.
    const toPhoto = invert(photoToSchematic(draft, draft.viewpoints[0])!)!
    const out = rectToOutline(toPhoto, { x: 400, y: 300, w: 100, h: 120 })
    expect(out === null || isValidQuad(out)).toBe(true)
  })

  it('accepted proposals are not used to fit the map', () => {
    const draft = gridDraft()
    const v = draft.viewpoints[0]
    const skewed = {
      ...draft,
      viewpoints: [
        {
          ...v,
          outlines: { ...v.outlines, 'A-01': [[0.9, 0.9], [0.95, 0.9], [0.95, 0.95], [0.9, 0.95]] as Outline },
          outlineReview: { ...v.outlineReview, 'A-01': { source: 'proposed' as const, status: 'accepted' as const } },
        },
      ],
    }
    expect(photoToSchematic(skewed, skewed.viewpoints[0])).toEqual(
      photoToSchematic(
        { ...draft, spaces: draft.spaces.filter((s) => s.spaceId !== 'A-01') },
        draft.viewpoints[0],
      ),
    )
  })

  it('suggests where an unoutlined space sits on the photo', () => {
    const draft = gridDraft()
    const extra = { ...draft, spaces: [...draft.spaces, space('B-05', 480, 240)] }
    const s = suggestOutline(extra, extra.viewpoints[0], 'B-05')!
    expect(s[0][0]).toBeCloseTo(outlineOf({ x: 480, y: 240, w: 100, h: 120 })[0][0], 3)
    expect(photoToSchematic(davidFixture(), davidFixture().viewpoints[0])).toBeNull()
  })
})

describe('map area growth', () => {
  it('shifts everything right and down when a space goes past the top-left edge', () => {
    const draft = davidFixture({ spaces: [space('A-01', -30, -10), space('A-02', 900, 500)] })
    const { draft: next, dx, dy } = fitSchematic(draft)
    expect([dx, dy]).toEqual([50, 30])
    expect(next.spaces[0].rect).toMatchObject({ x: 20, y: 20 })
    expect(next.schematic).toEqual({ width: 1050, height: 670 }) // A-02 just fits the shifted width; it sticks out below
  })

  it('grows right and down only as far as needed, and leaves a fitting draft alone', () => {
    const fits = davidFixture()
    expect(fitSchematic(fits).draft).toBe(fits)
    const wide = davidFixture({ spaces: [space('A-01', 950, 40)] })
    expect(fitSchematic(wide).draft.schematic).toEqual({ width: 1070, height: 600 })
  })

  it('afterRectChange grows the map after a drag past the edge', () => {
    const draft = davidFixture({ spaces: [space('A-01', 980, 40)] })
    expect(afterRectChange(draft, draft, ['A-01']).draft.schematic.width).toBe(1100)
  })

  it('labels a rect after the row it lines up with', () => {
    const spaces = gridDraft().spaces
    expect(labelForRect(spaces, { x: 600, y: 250, w: 100, h: 100 })).toBe('B-05')
    expect(labelForRect(spaces, { x: 600, y: 450, w: 100, h: 100 })).toBe('C-01')
  })
})
