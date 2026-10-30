import { describe, expect, it } from 'vitest'
import { davidFixture, space } from './fixtures/david'
import { fitSchematic } from './schematic/edits'
import { labelForRect } from './schematic/labels'
import {
  addSpaceFromOutline,
  addSpaceOnSchematic,
  afterRectChange,
  applyMat,
  fitTransform,
  invert,
  photoToSchematic,
  proposeOutlines,
  reprojectPending,
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

  it('moving a space moves its pending proposal, never an accepted outline', () => {
    const { draft, space: added } = addSpaceOnSchematic(gridDraft(), { x: 480, y: 40, w: 100, h: 120 })
    const moved = {
      ...draft,
      spaces: draft.spaces.map((s) =>
        s.spaceId === added.spaceId || s.spaceId === 'A-01' ? { ...s, rect: { ...s.rect, x: s.rect.x + 30 } } : s,
      ),
    }
    const next = reprojectPending(moved, [added.spaceId, 'A-01'])
    expect(next.viewpoints[0].outlines[added.spaceId]).not.toEqual(draft.viewpoints[0].outlines[added.spaceId])
    expect(next.viewpoints[0].outlines['A-01']).toEqual(draft.viewpoints[0].outlines['A-01'])
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
    expect(afterRectChange(draft, ['A-01']).draft.schematic.width).toBe(1100)
  })

  it('labels a rect after the row it lines up with', () => {
    const spaces = gridDraft().spaces
    expect(labelForRect(spaces, { x: 600, y: 250, w: 100, h: 100 })).toBe('B-05')
    expect(labelForRect(spaces, { x: 600, y: 450, w: 100, h: 100 })).toBe('C-01')
  })
})
