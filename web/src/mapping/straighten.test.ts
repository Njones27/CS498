import { describe, expect, it } from 'vitest'
import { pklotFixture } from './fixtures/pklot'
import { fitGrid, cellRect } from './schematic/grid'
import { duplicateLabelIds } from './schematic/labels'
import { MIN_STRAIGHTEN, straightenFoundCars, straightenFromPhoto, type StraightenResult } from './straighten'
import { PKLOT_CAR_STALLS } from './fixtures/pklotCars'
import { mergeProposals } from './proposals'
import type { DraftLayout, Outline, Point } from './types'

const ok = (r: StraightenResult | string): StraightenResult => {
  if (typeof r === 'string') throw new Error(r)
  return r
}

/** Rows by letter: the original labels of the spaces placed in it, left to right (new spaces left out). */
function rowsOf(before: DraftLayout, after: DraftLayout): Map<string, string[]> {
  const was = new Map(before.spaces.map((s) => [s.spaceId, s.label]))
  const rows = new Map<string, { num: number; was: string }[]>()
  for (const s of after.spaces.filter((sp) => was.has(sp.spaceId))) {
    const letter = s.label.split('-')[0]
    rows.set(letter, [...(rows.get(letter) ?? []), { num: Number(s.label.split('-')[1]), was: was.get(s.spaceId)! }])
  }
  return new Map([...rows].map(([k, v]) => [k, v.sort((a, b) => a.num - b.num).map((x) => x.was)]))
}

/** Every space fills the grid cell its label names, on the grid the labels describe. */
function expectOnGrid(draft: DraftLayout) {
  const g = fitGrid(draft.spaces)
  for (const s of draft.spaces) {
    const [row, num] = s.label.split('-')
    expect(cellRect(g, { row: row.charCodeAt(0) - 65, col: Number(num) - 1 })).toEqual(s.rect)
  }
}

/**
 * Two back-to-back rows of `n` stalls (2.5 m wide along the row, 5 m deep, sides leaning `skew` degrees),
 * filmed by a pinhole camera 26 m up, looking down 35 degrees at the lot, turned `yaw` degrees to the
 * rows; outlines as fractions of a 1280 x 720 photo.
 */
function obliqueLot(n: number, skew: number, yaw = 35): DraftLayout {
  const f = 1.3 * 1280
  const rad = (deg: number) => (deg * Math.PI) / 180
  const [tilt, turnBy] = [rad(35), rad(yaw)]
  const forward = [Math.cos(turnBy) * Math.cos(tilt), Math.sin(turnBy) * Math.cos(tilt), -Math.sin(tilt)]
  const right = [forward[1], -forward[0], 0].map((v) => v / Math.hypot(forward[0], forward[1]))
  const down = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]]
  const lotW = n * 2.5
  const back = 26 / Math.tan(tilt)
  const eye = [lotW / 2 - back * Math.cos(turnBy), 5 - back * Math.sin(turnBy), 26]
  const photo = ([x, y]: Point): Point => {
    const v = [x - eye[0], y - eye[1], -eye[2]]
    const z = v[0] * forward[0] + v[1] * forward[1] + v[2] * forward[2]
    const u = (f * (v[0] * right[0] + v[1] * right[1] + v[2] * right[2])) / z + 640
    const w = (f * (v[0] * down[0] + v[1] * down[1] + v[2] * down[2])) / z + 360
    return [u / 1280, w / 720]
  }
  const o = 5 * Math.tan(rad(skew))
  const spaces: DraftLayout['spaces'] = []
  const outlines: Record<string, Outline> = {}
  for (const [r, y0] of [0, 5].entries()) {
    for (let k = 0; k < n; k++) {
      const id = `s${r}${k}`
      const x = k * 2.5
      spaces.push({ spaceId: id, label: `Z-${k + 1}`, type: 'STANDARD', rect: { x: 20 + 40 * k, y: 20 + 300 * r, w: 40, h: 80 }, retired: false })
      outlines[id] = ([[x + o, y0], [x + 2.5 + o, y0], [x + 2.5, y0 + 5], [x, y0 + 5]] as Point[]).map(photo)
    }
  }
  return {
    lotId: 'oblique',
    revision: 1,
    basedOnVersion: null,
    updatedAt: '2026-11-03T12:00:00Z',
    updatedBy: null,
    schematic: { width: 1000, height: 800, northDeg: 90 },
    spaces,
    viewpoints: [{ viewId: 'V1', name: 'Camera', referenceImage: { url: '/p', width: 1280, height: 720 }, outlines, outlineReview: {} }],
  }
}

describe('straightenFromPhoto', () => {
  it('recovers straight rows from a camera at an angle: two rows back to back, numbered along, on the grid', () => {
    const before = obliqueLot(8, 0)
    for (const o of Object.values(before.viewpoints[0].outlines)) for (const [x, y] of o) expect(x > 0 && x < 1 && y > 0 && y < 1).toBe(true)
    const r = ok(straightenFromPhoto(before, 'V1'))
    expect([r.placed, r.rows]).toEqual([16, 2])
    const ids = (letter: string) => r.draft.spaces.filter((s) => s.label.startsWith(letter)).sort((a, b) => a.rect.x - b.rect.x).map((s) => s.spaceId)
    // The row further from the camera (higher in the photo) is on top.
    expect(ids('A')).toEqual(['s10', 's11', 's12', 's13', 's14', 's15', 's16', 's17'])
    expect(ids('B')).toEqual(['s00', 's01', 's02', 's03', 's04', 's05', 's06', 's07'])
    const a1 = r.draft.spaces.find((s) => s.label === 'A-01')!.rect
    const b1 = r.draft.spaces.find((s) => s.label === 'B-01')!.rect
    expect(b1.y).toBe(a1.y + a1.h) // back to back
    expect(a1.h / a1.w).toBeCloseTo(2, 0) // 5 m deep, 2.5 m wide
    expect(r.draft.spaces.every((s) => !s.skewDeg)).toBe(true)
    expectOnGrid(r.draft)
    // The old map was already straight, so north stays where it was.
    expect(Math.abs(r.turned)).toBeLessThan(5)
    expect(r.draft.schematic.northDeg).toBe((90 + r.turned + 360) % 360)
  })

  it('measures how far angled stalls lean, against the line their row runs along', () => {
    const r = ok(straightenFromPhoto(obliqueLot(8, 30), 'V1'))
    expect(r.rows).toBe(2)
    // The near row's open end leans right at the bottom of the map: anticlockwise.
    expect(r.leans).toEqual({ A: -30, B: -30 })
    expect(new Set(r.draft.spaces.map((s) => s.skewDeg))).toEqual(new Set([-30]))
  })

  it('finds a stall missing inside a row, outlined where it is on the photo', () => {
    const whole = obliqueLot(8, 30)
    const lot = obliqueLot(8, 30)
    lot.spaces = lot.spaces.filter((sp) => sp.spaceId !== 's03')
    delete lot.viewpoints[0].outlines.s03
    const r = ok(straightenFromPhoto(lot, 'V1'))
    expect([r.placed, r.found]).toEqual([15, 1])
    const added = r.draft.spaces.find((sp) => !lot.spaces.some((o) => o.spaceId === sp.spaceId))!
    expect(added.label).toBe('B-04') // between B-03 and B-05 (the near row is B)
    expect(added.skewDeg).toBe(-30)
    const v = r.draft.viewpoints[0]
    expect(v.outlineReview[added.spaceId]).toEqual({ source: 'proposed', status: 'pending', evidence: 0.3, newSpace: true })
    // Where the missing stall really is on the photo, within a few pixels.
    v.outlines[added.spaceId].forEach(([x, y], i) => {
      const [tx, ty] = whole.viewpoints[0].outlines.s03[i]
      expect(Math.hypot((x - tx) * 1280, (y - ty) * 720)).toBeLessThan(4)
    })
    expectOnGrid(r.draft)
  })

  it('on a lot already mapped, folds the cars Find stalls saw into its rows, fitting the ground on cars alone', () => {
    // PKLot as seeded (straightened), then Find stalls on its angled photo.
    const s = ok(straightenFromPhoto(pklotFixture(), 'V1'))
    const ids = new Set(s.draft.spaces.slice(0, 27).map((sp) => sp.spaceId))
    const seeded: DraftLayout = {
      ...s.draft,
      spaces: s.draft.spaces.slice(0, 27),
      viewpoints: s.draft.viewpoints.map((v) => ({ ...v, outlines: Object.fromEntries(Object.entries(v.outlines).filter(([id]) => ids.has(id))), outlineReview: {} })),
    }
    const merged = mergeProposals(seeded, 'V1', PKLOT_CAR_STALLS, fitGrid(seeded.spaces)).draft
    const r = straightenFoundCars(merged, 'V1', PKLOT_CAR_STALLS.flatMap((x) => x.paint ?? []), PKLOT_CAR_STALLS)
    if (typeof r === 'string') throw new Error(r)
    const was = new Map(seeded.spaces.map((sp) => [sp.spaceId, sp.label]))
    const rowOf = (label: string) => r.draft.spaces.find((sp) => was.get(sp.spaceId) === label)!.label[0]
    // The lot's own rows stay whole...
    for (const row of ['A', 'B', 'C', 'D']) {
      const letters = new Set(seeded.spaces.filter((sp) => sp.label[0] === row && sp.label !== 'C-01').map((sp) => rowOf(sp.label)))
      expect(letters.size).toBe(1)
    }
    // ...every row leans 45 degrees, the spaces keep their own outlines, and cars off the rows are left out.
    expect(new Set(Object.values(r.leans).map(Math.abs))).toEqual(new Set([45]))
    for (const sp of seeded.spaces) expect(r.draft.viewpoints[0].outlines[sp.spaceId]).toEqual(seeded.viewpoints[0].outlines[sp.spaceId])
    expect(r.dropped).toBeGreaterThan(0)
    expectOnGrid(r.draft)
  })

  it('takes the lean from paint on the ground over the outlines', () => {
    // Outlines drawn square to the row; the painted dividers beside them lean 45 degrees.
    const square = obliqueLot(8, 0)
    const painted = obliqueLot(8, 45)
    // Each stall's left side, bottom to top: a painted divider.
    const dividers = Object.values(painted.viewpoints[0].outlines).map(([a, , , d]) => [d[0], d[1], a[0], a[1]] as [number, number, number, number])
    expect(ok(straightenFromPhoto(square, 'V1')).leans).toEqual({ A: 0, B: 0 })
    expect(ok(straightenFromPhoto(square, 'V1', { paint: dividers })).leans).toEqual({ A: -45, B: -45 })
    // Too little paint to say leaves the outlines' lean.
    expect(ok(straightenFromPhoto(square, 'V1', { paint: dividers.slice(0, 3) })).leans).toEqual({ A: 0, B: 0 })
  })

  it('never gives a straightened space the label of a space seen only on another photo', () => {
    // A second camera sees two more spaces, already named A-01 and B-03; V1 doesn't see them.
    const lot = obliqueLot(8, 0)
    const elsewhere = [
      { spaceId: 'v2a', label: 'A-01', type: 'STANDARD' as const, rect: { x: 700, y: 20, w: 40, h: 80 }, retired: false },
      { spaceId: 'v2b', label: 'B-03', type: 'STANDARD' as const, rect: { x: 760, y: 20, w: 40, h: 80 }, retired: false },
    ]
    lot.spaces.push(...elsewhere)
    const r = ok(straightenFromPhoto(lot, 'V1'))
    const active = r.draft.spaces.filter((sp) => !sp.retired)
    expect(duplicateLabelIds(active)).toEqual(new Set())
    // Those two keep their names; the V1 stalls that would have taken them keep their old ones.
    expect(active.filter((sp) => sp.spaceId.startsWith('v2')).map((sp) => sp.label)).toEqual(['A-01', 'B-03'])
    expect(active.filter((sp) => /^[AB]-\d\d$/.test(sp.label))).toHaveLength(r.placed + r.found)
    expect(active.filter((sp) => sp.label.startsWith('Z-'))).toHaveLength(2)
  })

  it('leaves a straightened space blank, not duplicated, when its row label and its old one are both taken', () => {
    const lot = obliqueLot(8, 0)
    // Row A's first stall would be A-01, and was Z-1: another camera's spaces have both names.
    lot.spaces.push(
      { spaceId: 'v2a', label: 'A-01', type: 'STANDARD', rect: { x: 700, y: 20, w: 40, h: 80 }, retired: false },
      { spaceId: 'v2z', label: 'Z-1', type: 'STANDARD', rect: { x: 760, y: 20, w: 40, h: 80 }, retired: false },
    )
    const r = ok(straightenFromPhoto(lot, 'V1'))
    const active = r.draft.spaces.filter((sp) => !sp.retired)
    expect(duplicateLabelIds(active)).toEqual(new Set())
    expect(active.filter((sp) => !sp.label.trim())).toHaveLength(1)
  })

  it('numbers a wide bay right after its neighbour, not a column on', () => {
    // Row A's fifth stall is a van bay twice as wide, right beside the fourth.
    const lot = obliqueLot(8, 0)
    const v = lot.viewpoints[0]
    const wide = v.outlines.s14
    const next = v.outlines.s15
    v.outlines.s14 = [wide[0], next[1], next[2], wide[3]] as Outline
    delete v.outlines.s15
    lot.spaces = lot.spaces.filter((sp) => sp.spaceId !== 's15')
    const r = ok(straightenFromPhoto(lot, 'V1'))
    const far = r.draft.spaces.filter((sp) => sp.label.startsWith('A')).sort((a, b) => a.rect.x - b.rect.x).map((sp) => sp.label)
    expect(far).toEqual(['A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'A-07'])
  })

  it('north turns with the map', () => {
    const lot = obliqueLot(8, 0)
    // The old map stood on its side (rows running down the page): straightening turns it a quarter turn.
    lot.spaces = lot.spaces.map((s, i) => ({ ...s, rect: { x: 20 + 300 * Math.floor(i / 8), y: 20 + 40 * (i % 8), w: 80, h: 40 } }))
    const r = ok(straightenFromPhoto(lot, 'V1'))
    expect(Math.abs(Math.abs(r.turned) - 90)).toBeLessThan(5)
    expect(r.draft.schematic.northDeg).toBe((90 + r.turned + 360) % 360)
  })

  it('turns the angled camera lot (PKLot UFPR04) into its two double rows of 45-degree stalls, leaning alike', () => {
    const before = pklotFixture()
    const r = ok(straightenFromPhoto(before, before.viewpoints[0].viewId))
    expect([r.placed, r.rows]).toEqual([27, 4])
    // Row C's four-stall gap between E-01 and A-14 is filled with proposed stalls to review.
    expect(r.found).toBe(4)
    const rows = rowsOf(before, r.draft)
    // Left double row: the front stalls, then the ones behind them.
    expect(rows.get('A')).toEqual(['A-01', 'A-02', 'A-03', 'A-05', 'A-06', 'A-08', 'A-10'])
    expect(rows.get('B')).toEqual(['A-04', 'A-07', 'A-09', 'A-11', 'A-12', 'A-13'])
    // Right double row, past the drive; the two loosely drawn E boxes join the rows they sit in.
    expect(rows.get('C')).toEqual(['E-01', 'A-14', 'A-15', 'A-16', 'A-17', 'A-18'])
    expect(rows.get('D')).toEqual(['E-02', 'D-01', 'C-01', 'B-01', 'A-19', 'A-20', 'A-21', 'A-22'])
    // Both double rows lean the same way, as in the sketch.
    expect(r.leans).toEqual({ A: 45, B: 45, C: 45, D: 45 })
    const top = (letter: string) => Math.min(...r.draft.spaces.filter((s) => s.label.startsWith(letter)).map((s) => s.rect.y))
    const h = r.draft.spaces[0].rect.h
    expect(top('B')).toBe(top('A') + h)
    expect(top('C')).toBeGreaterThan(top('B') + h)
    expect(top('D')).toBe(top('C') + h)
    expect(new Set(r.draft.spaces.map((s) => s.label)).size).toBe(31)
    expect(r.draft.spaces.slice(0, 27).map((s) => s.spaceId)).toEqual(before.spaces.map((s) => s.spaceId))
    expect(r.draft.spaces.slice(27).map((s) => s.label)).toEqual(['C-02', 'C-03', 'C-04', 'C-05'])
    expectOnGrid(r.draft)
  })

  it('lays out a new lot from the cars Find stalls saw on the angled photo, nothing outlined by hand', () => {
    const empty: DraftLayout = {
      lotId: 'new',
      revision: 1,
      basedOnVersion: null,
      updatedAt: '2026-11-03T12:00:00Z',
      updatedBy: null,
      schematic: { width: 1000, height: 600 },
      spaces: [],
      viewpoints: [{ viewId: 'V1', name: 'Camera', referenceImage: { url: '/p', width: 1280, height: 720 }, outlines: {}, outlineReview: {} }],
    }
    const paint = PKLOT_CAR_STALLS.flatMap((s) => s.paint ?? [])
    const r = straightenFoundCars(mergeProposals(empty, 'V1', PKLOT_CAR_STALLS).draft, 'V1', paint)
    if (typeof r === 'string') throw new Error(r)
    // 47 cars: 8 stand off the rows (driving or stopped), 39 are parked in 7 rows; 7 empty stalls between.
    expect([r.dropped, r.placed, r.rows, r.found, r.loose.length]).toEqual([8, 39, 7, 7, 0])
    // The cars left out are named, so they can be put back as proposals (addLeftOutCars).
    expect(r.droppedIds).toHaveLength(8)
    expect(r.droppedIds.every((id) => !r.draft.spaces.some((sp) => sp.spaceId === id))).toBe(true)
    const sizes = new Map<string, number>()
    for (const s of r.draft.spaces) sizes.set(s.label[0], (sizes.get(s.label[0]) ?? 0) + 1)
    expect([...sizes.values()].every((n) => n >= 3)).toBe(true)
    // The paint beside the cars, flat on the ground, gives the lot's angle: 45 degrees (the cars' own
    // outlines, which have a height, would say 60). No row's own paint clearly says otherwise, so every
    // row is built at it, as lots are.
    expect(r.leans).toEqual({ A: 45, B: 45, C: 45, D: 45, E: 45, F: 45, G: 45 })
    expect(Object.values(r.paint).some((p) => p.departs)).toBe(false)
    for (const s of r.draft.spaces) expect(s.skewDeg ?? 0).toBe(r.leans[s.label[0]])

    // The two rows PKLot outlines by hand are the double rows B/C (left) and E/F (right) here...
    const seed = pklotFixture()
    const found = r.draft.viewpoints[0]
    const mid = (o: Outline) => [o.reduce((t, p) => t + p[0], 0) / 4, o.reduce((t, p) => t + p[1], 0) / 4]
    const rowAt = (o: Outline) => {
      const [x, y] = mid(o)
      return r.draft.spaces.reduce((a, b) => {
        const [ax, ay] = mid(found.outlines[a.spaceId])
        const [bx, by] = mid(found.outlines[b.spaceId])
        return Math.hypot(bx - x, by - y) < Math.hypot(ax - x, ay - y) ? b : a
      }).label[0]
    }
    const left = seed.spaces.filter((sp) => /^A-(0\d|1[0-3])$/.test(sp.label))
    const right = seed.spaces.filter((sp) => !left.includes(sp))
    expect(new Set(left.map((sp) => rowAt(seed.viewpoints[0].outlines[sp.spaceId])))).toEqual(new Set(['B', 'C']))
    expect(new Set(right.map((sp) => rowAt(seed.viewpoints[0].outlines[sp.spaceId])))).toEqual(new Set(['E', 'F']))
    // ...and each one's own paint, seen from above, leans 45 degrees from square to it.
    for (const row of ['B', 'C', 'E', 'F']) {
      expect(r.paint[row].ownLean).toBe(45)
      expect(r.paint[row].pieces).toBeGreaterThanOrEqual(50)
      expect(r.paint[row].share).toBeGreaterThan(0.5)
    }
    expectOnGrid(r.draft)
    const v = r.draft.viewpoints[0]
    expect(r.draft.spaces.every((s) => v.outlineReview[s.spaceId]?.status === 'pending')).toBe(true)
  })

  it('needs a photo and enough outlines, and keeps names like "Gate"', () => {
    const lot = obliqueLot(2, 0)
    expect(straightenFromPhoto(lot, 'V1')).toBe(`Outline at least ${MIN_STRAIGHTEN} spaces on this photo first (4 so far).`)
    expect(straightenFromPhoto({ ...lot, viewpoints: [{ ...lot.viewpoints[0], referenceImage: null }] }, 'V1')).toMatch(/no reference photo/)
    const named = obliqueLot(8, 0)
    named.spaces[0].label = 'Gate'
    const r = ok(straightenFromPhoto(named, 'V1'))
    expect(r.draft.spaces[0].label).toBe('Gate')
  })

  it('does not drop leftover pending proposals from prior runs as cars off the rows', () => {
    const empty: DraftLayout = {
      lotId: 'empty',
      revision: 0,
      basedOnVersion: null,
      updatedAt: '2026-10-28T00:00:00Z',
      updatedBy: 'test',
      schematic: { width: 1000, height: 600 },
      spaces: [],
      viewpoints: [{ viewId: 'V1', name: 'Camera', referenceImage: { url: '/p', width: 1280, height: 720 }, outlines: {}, outlineReview: {} }],
    }
    const paint = PKLOT_CAR_STALLS.flatMap((s) => s.paint ?? [])
    const merged1 = mergeProposals(empty, 'V1', PKLOT_CAR_STALLS)
    const leftoverId = 'sp_leftover_pending'
    const draftWithLeftover: DraftLayout = {
      ...merged1.draft,
      spaces: [...merged1.draft.spaces, { spaceId: leftoverId, label: 'Z-99', type: 'STANDARD', rect: { x: 900, y: 500, w: 40, h: 80 }, retired: false }],
      viewpoints: merged1.draft.viewpoints.map((v) => ({
        ...v,
        outlines: { ...v.outlines, [leftoverId]: [[0.9, 0.9], [0.95, 0.9], [0.95, 0.95], [0.9, 0.95]] },
        outlineReview: { ...v.outlineReview, [leftoverId]: { source: 'proposed', status: 'pending', newSpace: true } },
      })),
    }

    const r = straightenFoundCars(draftWithLeftover, 'V1', paint, PKLOT_CAR_STALLS, merged1.createdIds)
    if (typeof r === 'string') throw new Error(r)
    expect(r.draft.spaces.some((sp) => sp.spaceId === leftoverId)).toBe(true)
  })
})
