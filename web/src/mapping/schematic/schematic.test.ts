import { describe, expect, it } from 'vitest'
import { davidFixture, space } from '../fixtures/david'
import { addRow, addSpace, canDeleteSpace, deleteSpace, newSpaceId, updateSpace } from './edits'
import { clampRect, findFreeSpot, maxRowCount, medianSize, moveRect, placeNewSpace, resizeRect, rowRects } from './geometry'
import { duplicateLabelIds, nextLabel, nextRowStart, parseLabel, rowForNewSpace } from './labels'

const B = { width: 1000, height: 600 }

describe('labels', () => {
  it('parses row-number labels', () => {
    expect(parseLabel('B-04')).toEqual({ row: 'B', num: 4, digits: 2 })
    expect(parseLabel(' b7 ')).toEqual({ row: 'B', num: 7, digits: 1 })
    expect(parseLabel('Gate')).toBeNull()
    expect(parseLabel('')).toBeNull()
  })

  it('next unused label is the highest number in the row plus 1, retired spaces included', () => {
    const spaces = davidFixture().spaces // A-01..A-05, A-05 retired
    expect(nextLabel(spaces, 'A')).toBe('A-06')
    expect(nextLabel(spaces, 'B')).toBe('B-01')
    expect(nextLabel([space('x', 0, 0, { label: 'A-3' }), space('y', 0, 0, { label: 'A-9' })], 'A')).toBe('A-10')
    expect(nextLabel([space('x', 0, 0, { label: 'C-001' })], 'C')).toBe('C-002')
  })

  it('+ Space uses the selected space row, else row A', () => {
    const spaces = [...davidFixture().spaces, space('B-02', 40, 200), space('g', 0, 0, { label: 'Gate' })]
    expect(rowForNewSpace(spaces, null)).toBe('A')
    expect(rowForNewSpace(spaces, 'B-02')).toBe('B')
    expect(rowForNewSpace(spaces, 'g')).toBe('A')
    expect(rowForNewSpace(spaces, 'missing')).toBe('A')
  })

  it('suggests the next row for + Row', () => {
    expect(nextRowStart([])).toBe('A-01')
    expect(nextRowStart(davidFixture().spaces)).toBe('B-01')
    expect(nextRowStart([space('z', 0, 0, { label: 'Z-01' })])).toBe('')
  })

  it('finds duplicate labels among active spaces, trimmed and case-insensitive', () => {
    const spaces = [
      space('a', 0, 0, { label: 'B-04' }),
      space('b', 0, 0, { label: ' b-04 ' }),
      space('c', 0, 0, { label: 'B-04', retired: true }),
      space('d', 0, 0, { label: '' }),
      space('e', 0, 0, { label: ' ' }),
      space('f', 0, 0, { label: 'B-05' }),
    ]
    expect([...duplicateLabelIds(spaces)].sort()).toEqual(['a', 'b'])
  })
})

describe('geometry', () => {
  it('snaps to whole units and keeps rectangles inside the schematic', () => {
    expect(clampRect({ x: 10.4, y: 20.6, w: 100.2, h: 50.5 }, B)).toEqual({ x: 10, y: 21, w: 100, h: 51 })
    expect(clampRect({ x: 950, y: -5, w: 100, h: 120 }, B)).toEqual({ x: 900, y: 0, w: 100, h: 120 })
    expect(clampRect({ x: 0, y: 0, w: 2, h: 5000 }, B)).toEqual({ x: 0, y: 0, w: 10, h: 600 })
  })

  it('moves without changing size and stops at the edge', () => {
    const r = { x: 40, y: 40, w: 100, h: 120 }
    expect(moveRect(r, 25, -10, B)).toEqual({ x: 65, y: 30, w: 100, h: 120 })
    expect(moveRect(r, 5000, 5000, B)).toEqual({ x: 900, y: 480, w: 100, h: 120 })
    expect(moveRect(r, -5000, -5000, B)).toEqual({ x: 0, y: 0, w: 100, h: 120 })
  })

  it('resizes from each corner with the opposite corner fixed', () => {
    const r = { x: 100, y: 100, w: 100, h: 120 }
    expect(resizeRect(r, 'se', 20, 10, B)).toEqual({ x: 100, y: 100, w: 120, h: 130 })
    expect(resizeRect(r, 'nw', -20, -10, B)).toEqual({ x: 80, y: 90, w: 120, h: 130 })
    expect(resizeRect(r, 'ne', 20, -10, B)).toEqual({ x: 100, y: 90, w: 120, h: 130 })
    expect(resizeRect(r, 'sw', -20, 10, B)).toEqual({ x: 80, y: 100, w: 120, h: 130 })
  })

  it('resize keeps a minimum size and stays in bounds', () => {
    const r = { x: 100, y: 100, w: 100, h: 120 }
    expect(resizeRect(r, 'se', -500, -500, B)).toEqual({ x: 100, y: 100, w: 10, h: 10 })
    expect(resizeRect(r, 'nw', 500, 500, B)).toEqual({ x: 190, y: 210, w: 10, h: 10 })
    expect(resizeRect(r, 'se', 5000, 5000, B)).toEqual({ x: 100, y: 100, w: 900, h: 500 })
    expect(resizeRect(r, 'nw', -5000, -5000, B)).toEqual({ x: 0, y: 0, w: 200, h: 220 })
  })

  it('median size of a row', () => {
    expect(medianSize([])).toBeNull()
    expect(medianSize([{ x: 0, y: 0, w: 100, h: 120 }, { x: 0, y: 0, w: 80, h: 100 }, { x: 0, y: 0, w: 300, h: 90 }])).toEqual({
      w: 100,
      h: 100,
    })
  })

  it('places a new space right of its row, or on a new line when the row is full', () => {
    const all = davidFixture().spaces
    expect(placeNewSpace(all, all, { w: 100, h: 120 }, B)).toEqual({ x: 590, y: 40, w: 100, h: 120 })
    const full = [space('far', 890, 40)]
    expect(placeNewSpace(full, full, { w: 100, h: 120 }, B)).toEqual({ x: 20, y: 170, w: 100, h: 120 })
    expect(placeNewSpace([], [], { w: 100, h: 120 }, B)).toEqual({ x: 20, y: 20, w: 100, h: 120 })
  })

  it('places a new space in the first free spot when the row and the area below are full', () => {
    // Row A fills the right side and a space sits at the bottom: no room right of A or below.
    const all = [space('A-01', 300, 40, { rect: { x: 300, y: 40, w: 700, h: 120 } }), space('B-01', 0, 480)]
    const row = [all[0]]
    expect(placeNewSpace(all, row, { w: 100, h: 120 }, B)).toEqual({ x: 0, y: 0, w: 100, h: 120 })
    expect(findFreeSpot(all, { w: 100, h: 120 }, B)).toEqual({ x: 0, y: 0, w: 100, h: 120 })
  })

  it('overlaps only when the schematic is full', () => {
    const all = [space('big', 0, 0, { rect: { x: 0, y: 0, w: 1000, h: 600 } })]
    expect(findFreeSpot(all, { w: 100, h: 120 }, B)).toBeNull()
    const placed = placeNewSpace(all, [], { w: 100, h: 120 }, B)
    expect(placed.x + placed.w <= 1000 && placed.y + placed.h <= 600).toBe(true)
  })

  it('row rectangles are evenly spaced on one line and narrow to fit', () => {
    const fits = rowRects(5, { w: 100, h: 120 }, 170, B)
    expect(fits.map((r) => r.x)).toEqual([20, 130, 240, 350, 460])
    expect(new Set(fits.map((r) => `${r.y},${r.w},${r.h}`))).toEqual(new Set(['170,100,120']))

    const narrow = rowRects(12, { w: 100, h: 120 }, 170, B)
    const steps = narrow.slice(1).map((r, i) => r.x - narrow[i].x)
    expect(new Set(steps).size).toBe(1)
    expect(narrow.every((r) => r.w === narrow[0].w && r.x + r.w <= B.width)).toBe(true)

    const most = rowRects(maxRowCount(B), { w: 100, h: 120 }, 170, B)
    expect(most.every((r) => r.w >= 10 && r.x + r.w <= B.width)).toBe(true)
  })

  it('row below the bottom edge is pulled back inside', () => {
    expect(rowRects(2, { w: 100, h: 120 }, 590, B).map((r) => r.y)).toEqual([480, 480])
  })
})

describe('draft edits', () => {
  it('new ids are sp_ plus 8 lowercase letters or digits, and unique', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const id = newSpaceId(taken)
      expect(id).toMatch(/^sp_[a-z0-9]{8}$/)
      expect(taken.has(id)).toBe(false)
      taken.add(id)
    }
  })

  it('addSpace appends one standard space and leaves the input alone', () => {
    const draft = davidFixture()
    const { draft: next, space: added } = addSpace(draft, null)
    expect(draft.spaces).toHaveLength(5)
    expect(next.spaces).toHaveLength(6)
    expect(next.spaces[5]).toBe(added)
    expect(added).toMatchObject({ label: 'A-06', type: 'STANDARD', retired: false, rect: { x: 590, y: 40, w: 100, h: 120 } })
  })

  it('addSpace sizes from the row median', () => {
    const draft = davidFixture({
      spaces: [space('B-01', 40, 200, { rect: { x: 40, y: 200, w: 60, h: 80 } }), ...davidFixture().spaces],
    })
    const { space: added } = addSpace(draft, 'B-01')
    expect(added).toMatchObject({ label: 'B-02', rect: { x: 110, y: 200, w: 60, h: 80 } })
  })

  it('addRow labels from the start label and keeps its padding', () => {
    const { spaces } = addRow(davidFixture(), { row: 'C', num: 8, digits: 2 }, 3)
    expect(spaces.map((s) => s.label)).toEqual(['C-08', 'C-09', 'C-10'])
    expect(new Set(spaces.map((s) => s.spaceId)).size).toBe(3)
  })

  it('updateSpace patches one space only', () => {
    const next = updateSpace(davidFixture(), 'A-03', { type: 'EV' })
    expect(next.spaces.find((s) => s.spaceId === 'A-03')?.type).toBe('EV')
    expect(next.spaces.find((s) => s.spaceId === 'A-01')?.type).toBe('STANDARD')
  })

  it('deleteSpace removes the space and its outlines', () => {
    const next = deleteSpace(davidFixture(), 'A-01')
    expect(next.spaces.map((s) => s.spaceId)).not.toContain('A-01')
    expect(next.viewpoints[0].outlines).not.toHaveProperty('A-01')
    expect(next.viewpoints[0].outlineReview).not.toHaveProperty('A-01')
    expect(next.viewpoints[0].outlines).toHaveProperty('A-05')
  })

  it('only never-published spaces can be deleted', () => {
    const published = new Set(['A-01'])
    expect(canDeleteSpace('A-01', null, published)).toBe(true)
    expect(canDeleteSpace('A-01', 3, published)).toBe(false)
    expect(canDeleteSpace('sp_new00001', 3, published)).toBe(true)
  })
})
