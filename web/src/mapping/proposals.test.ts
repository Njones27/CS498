import { describe, expect, it } from 'vitest'
import {
  acceptProposals,
  alignRowsToPhoto,
  area,
  findWideStalls,
  forgetRejected,
  groundSizes,
  mergeWideStalls,
  insidePolygon,
  MAX_REJECTED,
  mergeProposals,
  NEEDS_ANCHORS,
  normalizedStallWidth,
  pendingProposals,
  touchesPhotoEdge,
  rejectProposals,
  type ProposedStall,
} from './proposals'
import { cellRect, fitGrid } from './schematic/grid'
import { photoToSchematic } from './sync'
import { straightenFromPhoto } from './straighten'
import { pklotFixture } from './fixtures/pklot'
import { PKLOT_CAR_STALLS } from './fixtures/pklotCars'
import type { DraftLayout, DraftSpace, Outline, Point } from './types'

const box = (x: number, y: number, w: number, h: number): Outline => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
]

/** A stall `col` in proposer row `row`: 0.05 wide, 0.1 deep, rows 0.15 apart. */
function stall(row: number, col: number, evidence = 0.8): ProposedStall {
  const x = 0.1 + col * 0.05
  const y = 0.1 + row * 0.15
  return { polygon: box(x, y, 0.05, 0.1), evidence, row, col, mapRect: { x: col * 0.05, y: row * 0.15, w: 0.05, h: 0.1 }, partial: false }
}

function emptyDraft(): DraftLayout {
  return {
    lotId: 'new-lot',
    revision: 0,
    basedOnVersion: null,
    updatedAt: '2026-10-30T12:00:00Z',
    updatedBy: 'admin@example.edu',
    schematic: { width: 1000, height: 600 },
    spaces: [],
    viewpoints: [
      {
        viewId: 'V1',
        name: 'Overhead',
        referenceImage: { url: '/photo', width: 2000, height: 2000 },
        outlines: {},
        outlineReview: {},
      },
      { viewId: 'V2', name: 'Side', referenceImage: null, outlines: {}, outlineReview: {} },
    ],
  }
}

const space = (spaceId: string, label: string, x: number, y: number): DraftSpace => ({
  spaceId,
  label,
  type: 'STANDARD',
  rect: { x, y, w: 50, h: 100 },
  retired: false,
})

describe('mergeProposals', () => {
  it('lays out a new lot from the proposer: rows A, B, stalls 01 onward, pending with evidence', () => {
    const stalls = [stall(0, 1), stall(0, 0, 0.3), stall(0, 2), stall(1, 0), stall(1, 1)]
    const { draft, added, skipped } = mergeProposals(emptyDraft(), 'V1', stalls)
    expect(added).toBe(5)
    expect(skipped).toBe(0)
    expect(draft.spaces.map((s) => s.label)).toEqual(['A-02', 'A-01', 'A-03', 'B-01', 'B-02'])
    const v1 = draft.viewpoints[0]
    for (const [i, s] of draft.spaces.entries()) {
      expect(v1.outlines[s.spaceId]).toEqual(stalls[i].polygon)
      expect(v1.outlineReview?.[s.spaceId]).toEqual({
        source: 'proposed',
        status: 'pending',
        evidence: stalls[i].evidence,
        newSpace: true,
      })
      expect(s.spaceId).toMatch(/^sp_[a-z0-9]{8}$/)
      const r = s.rect
      expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= draft.schematic.width && r.y + r.h <= draft.schematic.height).toBe(true)
    }
    // Neighbours touch on the map (edges rounded, not sizes), so they never overlap.
    const [a2, a1] = draft.spaces
    expect(a1.rect.x + a1.rect.w).toBe(a2.rect.x)
    // Row B sits below row A.
    expect(draft.spaces[3].rect.y).toBeGreaterThan(a1.rect.y + a1.rect.h - 1)
    // Other views are left alone.
    expect(draft.viewpoints[1]).toEqual(emptyDraft().viewpoints[1])
  })

  it('lays a new lot out on a clean grid: every stall in its label\'s cell, rows back to back, aisles kept', () => {
    // Rows 0+1 back to back, a drive, then row 2 starting one stall in; one wide stall in row 0.
    const at = (row: number, col: number, x: number, y: number, w = 0.05): ProposedStall => ({
      ...stall(row, col),
      mapRect: { x, y, w, h: 0.1 },
    })
    const stalls = [
      at(0, 0, 0, 0), at(0, 1, 0.05, 0, 0.08), at(0, 2, 0.13, 0),
      at(1, 0, 0, 0.1), at(1, 1, 0.05, 0.1),
      at(2, 0, 0.05, 0.35), at(2, 1, 0.1, 0.35),
    ]
    const { draft } = mergeProposals(emptyDraft(), 'V1', stalls)
    expect(draft.spaces.map((s) => s.label)).toEqual(['A-01', 'A-02', 'A-03', 'B-01', 'B-02', 'C-02', 'C-03'])
    const g = fitGrid(draft.spaces)
    expect(g.aisles).toHaveLength(1)
    expect(g.aisles![0].row).toBe(2)
    for (const s of draft.spaces) {
      const [row, num] = [s.label.charCodeAt(0) - 65, Number(s.label.slice(2))]
      expect(cellRect(g, { row, col: num - 1 })).toEqual(s.rect)
    }
  })

  it('caps the stall size on the map for a lot with few stalls', () => {
    const { draft } = mergeProposals(emptyDraft(), 'V1', [stall(0, 0), stall(0, 1)])
    expect(draft.spaces[0].rect.w).toBeLessThanOrEqual(110)
  })

  it('skips stalls already outlined in the view and labels new rows after those in use', () => {
    const base = emptyDraft()
    base.spaces = [space('s1', 'A-01', 20, 20)]
    base.viewpoints[0].outlines = { s1: stall(0, 0).polygon as Outline }
    const { draft, added, skipped } = mergeProposals(base, 'V1', [stall(0, 0), stall(1, 0), stall(1, 1)])
    expect(skipped).toBe(1)
    expect(added).toBe(2)
    expect(draft.spaces.slice(1).map((s) => s.label)).toEqual(['B-01', 'B-02'])
    // Placed below the space already there.
    expect(draft.spaces[1].rect.y).toBeGreaterThanOrEqual(120)
  })

  it('places stalls by the photo fit once four spaces are outlined', () => {
    const base = emptyDraft()
    // Photo fraction (x, y) maps to the schematic at (x * 1000, y * 1000): four drawn anchors.
    base.spaces = [
      space('s1', 'A-01', 100, 100),
      space('s2', 'A-02', 150, 100),
      space('s3', 'B-01', 100, 250),
      space('s4', 'B-02', 150, 250),
    ]
    base.viewpoints[0].outlines = {
      s1: box(0.1, 0.1, 0.05, 0.1),
      s2: box(0.15, 0.1, 0.05, 0.1),
      s3: box(0.1, 0.25, 0.05, 0.1),
      s4: box(0.15, 0.25, 0.05, 0.1),
    }
    const { draft, added } = mergeProposals(base, 'V1', [stall(0, 2)])
    expect(added).toBe(1)
    const added0 = draft.spaces[4]
    expect(added0.rect.x).toBeCloseTo(200, -1)
    expect(added0.rect.y).toBeCloseTo(100, -1)
    expect(added0.label).toBe('A-03') // the row it lines up with
  })

  it('refuses to add stalls it cannot match to spaces this photo does not show yet', () => {
    const base = emptyDraft()
    base.spaces = [space('s1', 'A-01', 20, 20), space('s2', 'A-02', 80, 20)]
    base.viewpoints[1].outlines = { s1: box(0.1, 0.1, 0.05, 0.1), s2: box(0.15, 0.1, 0.05, 0.1) }
    const result = mergeProposals(base, 'V1', [stall(0, 0), stall(0, 1)])
    expect(result.blocked).toBe(NEEDS_ANCHORS)
    expect(result.draft).toBe(base)
    expect(result.added + result.attached).toBe(0)
  })

  it('with a fit, matches stalls to spaces seen from another view instead of duplicating them', () => {
    const base = emptyDraft()
    // Four drawn anchors in V1 (photo fraction (x, y) -> map (x * 1000, y * 1000)), plus A-03 on the map
    // with an outline only in V2.
    base.spaces = [
      space('s1', 'A-01', 100, 100),
      space('s2', 'A-02', 150, 100),
      space('s3', 'B-01', 100, 250),
      space('s4', 'B-02', 150, 250),
      space('s5', 'A-03', 200, 100),
    ]
    base.viewpoints[0].outlines = {
      s1: box(0.1, 0.1, 0.05, 0.1),
      s2: box(0.15, 0.1, 0.05, 0.1),
      s3: box(0.1, 0.25, 0.05, 0.1),
      s4: box(0.15, 0.25, 0.05, 0.1),
    }
    base.viewpoints[1].outlines = { s5: box(0.5, 0.5, 0.1, 0.1) }
    const { draft, added, attached } = mergeProposals(base, 'V1', [stall(0, 2), stall(0, 3)])
    expect(attached).toBe(1)
    expect(added).toBe(1)
    expect(draft.spaces).toHaveLength(6)
    const v1 = draft.viewpoints[0]
    expect(v1.outlines.s5).toEqual(stall(0, 2).polygon)
    expect(v1.outlineReview?.s5).toEqual({ source: 'proposed', status: 'pending', evidence: 0.8 })
    // Rejecting the matched stall keeps the space it was matched to.
    const { draft: rejected, removedSpaces } = rejectProposals(draft, 'V1', ['s5'])
    expect(removedSpaces).toBe(0)
    expect(rejected.spaces.map((s) => s.spaceId)).toContain('s5')
  })

  it('accepted found stalls anchor the photo fit; pending ones do not', () => {
    const { draft } = mergeProposals(emptyDraft(), 'V1', [stall(0, 0), stall(0, 1), stall(1, 0), stall(1, 1)])
    expect(photoToSchematic(draft, draft.viewpoints[0])).toBeNull()
    const accepted = acceptProposals(draft, 'V1', draft.spaces.map((s) => s.spaceId))
    expect(photoToSchematic(accepted, accepted.viewpoints[0])).not.toBeNull()
  })

  it('does nothing for an unknown view or no stalls', () => {
    const d = emptyDraft()
    expect(mergeProposals(d, 'V9', [stall(0, 0)]).draft).toBe(d)
    expect(mergeProposals(d, 'V1', []).draft).toBe(d)
  })
})

describe('mergeProposals on a mapped lot (like the seeded drone lot)', () => {
  /** Rows A and B, four stalls each, outlined on V1: photo fraction (x, y) sits at map (x * 1000, y * 1000). */
  function mappedLot(): DraftLayout {
    const d = emptyDraft()
    d.schematic = { width: 1000, height: 600 }
    for (const [r, row] of ['A', 'B'].entries()) {
      for (let c = 0; c < 4; c++) {
        const id = `${row}${c + 1}`
        d.spaces.push(space(id, `${row}-0${c + 1}`, 200 + c * 50, 100 + r * 150))
        d.viewpoints[0].outlines[id] = box(0.2 + c * 0.05, 0.1 + r * 0.15, 0.05, 0.1)
      }
    }
    return d
  }
  const at = (row: number, col: number): ProposedStall => ({
    polygon: box(0.2 + col * 0.05, 0.1 + row * 0.15, 0.05, 0.1),
    evidence: 0.8,
    row,
    col: Math.max(0, col),
    mapRect: { x: 0, y: 0, w: 0.05, h: 0.1 },
    partial: false,
  })

  it('puts stalls past a row end in that row, named for the cell', () => {
    const d = mappedLot()
    const { draft, added } = mergeProposals(d, 'V1', [at(0, 4), at(1, 4)], fitGrid(d.spaces))
    expect(added).toBe(2)
    const byLabel = new Map(draft.spaces.map((s) => [s.label, s]))
    expect(byLabel.get('A-05')?.rect).toEqual({ ...byLabel.get('A-04')!.rect, x: byLabel.get('A-04')!.rect.x + 50 })
    expect(byLabel.get('B-05')?.rect.y).toBe(byLabel.get('B-04')!.rect.y)
  })

  it('inserts stalls before a row start at the start, renumbering the row', () => {
    const d = mappedLot()
    const { draft, added } = mergeProposals(d, 'V1', [at(0, -2), at(0, -1)], fitGrid(d.spaces))
    expect(added).toBe(2)
    const rowA = draft.spaces.filter((s) => s.label.startsWith('A-')).sort((a, b) => a.rect.x - b.rect.x)
    expect(rowA.map((s) => s.label)).toEqual(['A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06'])
    expect(new Set(rowA.map((s) => s.rect.y))).toEqual(new Set([rowA[0].rect.y])) // one line
    expect(rowA.slice(2).map((s) => s.spaceId)).toEqual(['A1', 'A2', 'A3', 'A4'])
    const v1 = draft.viewpoints[0]
    for (const s of rowA.slice(0, 2)) {
      expect(v1.outlineReview?.[s.spaceId]).toEqual({ source: 'proposed', status: 'pending', evidence: 0.8, newSpace: true })
    }
  })
})

describe('review helpers', () => {
  function reviewed(): DraftLayout {
    const { draft } = mergeProposals(emptyDraft(), 'V1', [stall(0, 0, 0.9), stall(0, 1, 0.1), stall(0, 2, 0.5)])
    return draft
  }

  it('lists pending proposals weakest first, unscored last', () => {
    const d = reviewed()
    const v1 = d.viewpoints[0]
    const [a1, a2, a3] = d.spaces.map((s) => s.spaceId)
    v1.outlines.x = box(0.5, 0.5, 0.05, 0.1)
    v1.outlineReview!.x = { source: 'proposed', status: 'pending' }
    expect(pendingProposals(v1).map((p) => p.spaceId)).toEqual([a2, a3, a1, 'x'])
  })

  it('accepting keeps the outline and its evidence', () => {
    const d = reviewed()
    const id = d.spaces[1].spaceId
    const next = acceptProposals(d, 'V1', [id])
    expect(next.viewpoints[0].outlineReview?.[id]).toEqual({
      source: 'proposed',
      status: 'accepted',
      evidence: 0.1,
      newSpace: true,
    })
    expect(pendingProposals(next.viewpoints[0])).toHaveLength(2)
  })

  it('rejecting a found stall removes the space; one outlined elsewhere keeps it', () => {
    const d = reviewed()
    const [keep, drop] = d.spaces.map((s) => s.spaceId)
    d.viewpoints[1].outlines[keep] = box(0.2, 0.2, 0.1, 0.1)
    const { draft: next, removedSpaces } = rejectProposals(d, 'V1', [keep, drop])
    expect(removedSpaces).toBe(1)
    expect(next.spaces.map((s) => s.spaceId)).not.toContain(drop)
    expect(next.spaces.map((s) => s.spaceId)).toContain(keep)
    expect(next.viewpoints[0].outlines[keep]).toBeUndefined()
    expect(next.viewpoints[0].outlineReview?.[keep]).toBeUndefined()
    expect(next.viewpoints[1].outlines[keep]).toBeDefined()
  })

  it('rejecting a proposal the proposer did not create a space for keeps the space', () => {
    const d = emptyDraft()
    d.spaces = [space('s1', 'A-01', 20, 20)]
    d.viewpoints[0].outlines = { s1: box(0.1, 0.1, 0.05, 0.1) }
    d.viewpoints[0].outlineReview = { s1: { source: 'proposed', status: 'pending' } }
    const { draft: next, removedSpaces } = rejectProposals(d, 'V1', ['s1'])
    expect(removedSpaces).toBe(0)
    expect(next.spaces).toHaveLength(1)
    expect(next.viewpoints[0].outlines.s1).toBeUndefined()
  })

  it('a rejected stall stays rejected: the next Find stalls leaves it out and counts it', () => {
    const d = reviewed()
    const drop = d.spaces[1].spaceId
    const { draft: next } = rejectProposals(d, 'V1', [drop])
    expect(next.viewpoints[0].rejectedStalls).toEqual([stall(0, 1).polygon])
    // The proposer finds it again, a little off where it was, along with a stall nobody has seen.
    const again: ProposedStall = { ...stall(0, 1), polygon: box(0.153, 0.102, 0.05, 0.1) }
    const merged = mergeProposals(next, 'V1', [stall(0, 0), again, stall(0, 2), stall(0, 5)])
    expect(merged.skipped).toBe(2) // cols 0 and 2 are still outlined
    expect(merged.rejected).toBe(1)
    expect(merged.added).toBe(1)
    expect(Object.values(merged.draft.viewpoints[0].outlines)).not.toContainEqual(again.polygon)
  })

  it('a rejected wide stall does not hide the stalls inside it, and a collapsed outline hides nothing', () => {
    const d = reviewed()
    // The admin rejected a proposal two stalls wide (cols 6 and 7), and one squashed flat.
    d.viewpoints[0].rejectedStalls = [box(0.4, 0.1, 0.1, 0.1), box(0.6, 0.1, 0.05, 0)]
    const merged = mergeProposals(d, 'V1', [stall(0, 6), stall(0, 7), stall(0, 10)])
    expect(merged.rejected).toBe(0)
    expect(merged.added).toBe(3)
  })

  it('remembers only rejected proposals, the latest MAX_REJECTED of them', () => {
    const d = reviewed()
    const [first, second] = d.spaces.map((s) => s.spaceId)
    const accepted = acceptProposals(d, 'V1', [first])
    expect(rejectProposals(accepted, 'V1', [first]).draft.viewpoints[0].rejectedStalls ?? []).toEqual([])
    d.viewpoints[0].rejectedStalls = Array.from({ length: MAX_REJECTED }, (_, i) => box(0.9, i / MAX_REJECTED, 0.01, 0.001))
    const kept = rejectProposals(d, 'V1', [second]).draft.viewpoints[0].rejectedStalls!
    expect(kept).toHaveLength(MAX_REJECTED)
    expect(kept.at(-1)).toEqual(stall(0, 1).polygon)
  })

  it('forgetting the rejected stalls lets Find stalls propose them again', () => {
    const d = reviewed()
    const { draft: next } = rejectProposals(d, 'V1', [d.spaces[1].spaceId])
    const forgotten = forgetRejected(next, 'V1')
    expect(forgotten.viewpoints[0].rejectedStalls).toEqual([])
    const merged = mergeProposals(forgotten, 'V1', [stall(0, 1)])
    expect(merged.rejected).toBe(0)
    expect(merged.added).toBe(1)
  })

  it('insidePolygon', () => {
    const sq = box(0, 0, 1, 1)
    expect(insidePolygon([0.5, 0.5], sq)).toBe(true)
    expect(insidePolygon([1.5, 0.5], sq)).toBe(false)
  })
})

describe('partly visible stalls', () => {
  it('an outline up to the photo border is a cut-off stall', () => {
    expect(touchesPhotoEdge(box(0.1, 0, 0.05, 0.03))).toBe(true) // top row, cut by the border
    expect(touchesPhotoEdge(box(0.1, 0.95, 0.05, 0.05))).toBe(true) // bottom row
    expect(touchesPhotoEdge(box(0.1, 0.1, 0.05, 0.1))).toBe(false)
  })

  it('the review list says which proposals are partly outside the photo', () => {
    const cut: ProposedStall = { ...stall(0, 0), polygon: box(0.1, 0, 0.05, 0.03), evidence: 0.3, partial: true }
    const { draft } = mergeProposals(emptyDraft(), 'V1', [cut, stall(1, 0)])
    const pending = pendingProposals(draft.viewpoints[0])
    expect(pending.map((p) => p.partial)).toEqual([true, false]) // weakest first
  })
})

describe('cut-off rows on a mapped lot', () => {
  /** Rows A..D, four stalls each, unevenly spaced like a real lot: A, then B and C back to back, then D
   * past a wide aisle. Photo y of each row's top; map rows 150 apart. */
  const ROW_Y = [0.1, 0.35, 0.45, 0.7]
  function unevenLot(): DraftLayout {
    const d = emptyDraft()
    ROW_Y.forEach((y, r) => {
      const row = 'ABCD'[r]
      for (let c = 0; c < 4; c++) {
        const id = `${row}${c + 1}`
        d.spaces.push(space(id, `${row}-0${c + 1}`, 200 + c * 50, 100 + r * 150))
        d.viewpoints[0].outlines[id] = box(0.2 + c * 0.05, y, 0.05, 0.1)
      }
    })
    d.schematic = { width: 1000, height: 800 }
    return d
  }
  /** A stall of row `row` (photo top y) the photo cuts at the bottom border, at column `col`. */
  const cut = (col: number, top: number): ProposedStall => ({
    polygon: box(0.2 + col * 0.05, top, 0.05, 1 - top),
    wholePolygon: box(0.2 + col * 0.05, top, 0.05, 0.1),
    evidence: 0.3,
    row: 9,
    col,
    mapRect: { x: 0, y: 0, w: 0.05, h: 0.1 },
    partial: true,
  })

  it('a row past the last one becomes a new row, though the rows are unevenly spaced', () => {
    const d = unevenLot()
    const { draft, added } = mergeProposals(d, 'V1', [cut(0, 0.8), cut(1, 0.8)], fitGrid(d.spaces))
    expect(added).toBe(2)
    const newRow = draft.spaces.filter((s) => s.label.startsWith('E-'))
    expect(newRow.map((s) => s.label).sort()).toEqual(['E-01', 'E-02'])
    const rowD = draft.spaces.find((s) => s.label === 'D-01')!
    expect(newRow[0].rect.y).toBeGreaterThan(rowD.rect.y) // below D on the map
    // Placed by the whole stall, stored as the part in view.
    const v1 = draft.viewpoints[0]
    expect(v1.outlines[newRow[0].spaceId].every(([, y]) => y <= 1)).toBe(true)
    expect(touchesPhotoEdge(v1.outlines[newRow[0].spaceId] as Point[])).toBe(true)
  })
})


describe('wide stalls drawn as several spaces', () => {
  /** A row on the photo: stalls 0.05 wide, but the third is a wide bay 0.075 across (1.5 stalls). */
  function photoRow(): ProposedStall[] {
    const xs = [0.1, 0.15, 0.2, 0.275, 0.325]
    return xs.map((x, col) => ({
      polygon: box(x, 0.1, (xs[col + 1] ?? x + 0.05) - x, 0.1),
      evidence: 0.8,
      row: 0,
      col,
      mapRect: { x: x - 0.1, y: 0, w: (xs[col + 1] ?? x + 0.05) - x, h: 0.1 },
      partial: false,
    }))
  }
  /** The lot drew that row as six even spaces: the wide bay holds most of two of them (C-04, C-05). */
  function drawnEvenly(): DraftLayout {
    const d = emptyDraft()
    d.spaces = [0, 1, 2, 3, 4, 5].map((k) => space(`s${k}`, `C-0${k + 1}`, 20 + 50 * k, 20))
    d.viewpoints[0].outlines = Object.fromEntries(d.spaces.map((sp, k) => [sp.spaceId, box(0.1 + 0.0375 * k, 0.1, 0.0375, 0.1)]))
    return d
  }

  it('finds a wide stall the lot drew as two spaces, and not a stall a space only reaches into', () => {
    const d = drawnEvenly()
    const wide = findWideStalls(d, 'V1', photoRow())
    expect(wide).toHaveLength(1)
    expect(wide[0].stall.col).toBe(2)
    expect(wide[0].spaceIds).toEqual(['s3', 's4']) // left to right; C-03 only reaches a third in
    // The same row drawn right, one space in the wide bay: nothing to say.
    const right = emptyDraft()
    right.spaces = photoRow().map((_, k) => space(`r${k}`, `C-0${k + 1}`, 20 + 50 * k, 20))
    right.viewpoints[0].outlines = Object.fromEntries(right.spaces.map((sp, k) => [sp.spaceId, photoRow()[k].polygon as Outline]))
    expect(findWideStalls(right, 'V1', photoRow())).toEqual([])
  })

  it('Find stalls reports them with what it merges', () => {
    const d = drawnEvenly()
    expect(mergeProposals(d, 'V1', photoRow()).wide.map((w) => w.spaceIds)).toEqual([['s3', 's4']])
  })

  it('merging keeps the first space over both cells with the wide outline to review, and retires published spaces', () => {
    const d = drawnEvenly()
    d.basedOnVersion = 1
    const published = new Set(d.spaces.map((sp) => sp.spaceId))
    const wide = findWideStalls(d, 'V1', photoRow())
    const next = mergeWideStalls(d, 'V1', wide, published)
    const kept = next.spaces.find((sp) => sp.spaceId === 's3')!
    expect(kept.rect).toEqual({ x: 170, y: 20, w: 100, h: 100 }) // C-04's and C-05's cells
    expect(next.spaces.find((sp) => sp.spaceId === 's4')!.retired).toBe(true)
    const v1 = next.viewpoints[0]
    expect(v1.outlines.s3).toEqual(photoRow()[2].polygon)
    expect(v1.outlineReview.s3).toEqual({ source: 'proposed', status: 'pending', evidence: 0.8 })
    expect(v1.outlines.s4).toBeUndefined()
    expect(next.spaces.filter((sp) => !sp.retired)).toHaveLength(5)
  })

  it('merging deletes never-published spaces instead of retiring them', () => {
    const d = drawnEvenly() // basedOnVersion is null
    const wide = findWideStalls(d, 'V1', photoRow())
    const next = mergeWideStalls(d, 'V1', wide)
    const kept = next.spaces.find((sp) => sp.spaceId === 's3')!
    expect(kept.rect).toEqual({ x: 170, y: 20, w: 100, h: 100 })
    expect(next.spaces.find((sp) => sp.spaceId === 's4')).toBeUndefined()
    expect(next.spaces).toHaveLength(5)
  })

  it('does not falsely flag near-camera perspective stalls as wide', () => {
    // In perspective, near-camera stalls have larger 2D area (e.g. 0.08x0.16 vs 0.04x0.08) but identical 0.5 aspect ratio
    const stalls: ProposedStall[] = [
      { polygon: box(0.1, 0.1, 0.08, 0.16), evidence: 0.8, row: 0, col: 0, mapRect: { x: 0, y: 0, w: 0.08, h: 0.16 }, partial: false },
      { polygon: box(0.2, 0.1, 0.06, 0.12), evidence: 0.8, row: 0, col: 1, mapRect: { x: 0.08, y: 0, w: 0.06, h: 0.12 }, partial: false },
      { polygon: box(0.3, 0.1, 0.04, 0.08), evidence: 0.8, row: 0, col: 2, mapRect: { x: 0.14, y: 0, w: 0.04, h: 0.08 }, partial: false },
    ]
    const d = emptyDraft()
    d.spaces = [0, 1, 2].map((k) => space(`s${k}`, `A-0${k + 1}`, 20 + 50 * k, 20))
    d.viewpoints[0].outlines = Object.fromEntries(d.spaces.map((sp, k) => [sp.spaceId, stalls[k].polygon as Outline]))
    // Even though stall 0 has 4x the 2D area of stall 2, it is not a wide stall
    expect(findWideStalls(d, 'V1', stalls)).toEqual([])
  })

  it('flags a quadruple-width bay (4x2) in a row of normal 1x2 stalls', () => {
    // Normal stalls are 0.05 wide x 0.1 deep (ratio 0.5); the wide bay is 0.20 wide x 0.1 deep (ratio 2.0)
    const stalls: ProposedStall[] = [
      { polygon: box(0.10, 0.1, 0.05, 0.1), evidence: 0.8, row: 0, col: 0, mapRect: { x: 0, y: 0, w: 0.05, h: 0.1 }, partial: false },
      { polygon: box(0.15, 0.1, 0.05, 0.1), evidence: 0.8, row: 0, col: 1, mapRect: { x: 0.05, y: 0, w: 0.05, h: 0.1 }, partial: false },
      { polygon: box(0.20, 0.1, 0.20, 0.1), evidence: 0.8, row: 0, col: 2, mapRect: { x: 0.10, y: 0, w: 0.20, h: 0.1 }, partial: false },
      { polygon: box(0.40, 0.1, 0.05, 0.1), evidence: 0.8, row: 0, col: 3, mapRect: { x: 0.30, y: 0, w: 0.05, h: 0.1 }, partial: false },
    ]
    const d = emptyDraft()
    // The lot drew the 4x2 bay as four separate spaces: s2, s3, s4, s5
    d.spaces = [
      space('s0', 'A-01', 20, 20),
      space('s1', 'A-02', 70, 20),
      space('s2', 'A-03', 120, 20),
      space('s3', 'A-04', 170, 20),
      space('s4', 'A-05', 220, 20),
      space('s5', 'A-06', 270, 20),
      space('s6', 'A-07', 320, 20),
    ]
    d.viewpoints[0].outlines = {
      s0: box(0.10, 0.1, 0.05, 0.1),
      s1: box(0.15, 0.1, 0.05, 0.1),
      s2: box(0.20, 0.1, 0.05, 0.1),
      s3: box(0.25, 0.1, 0.05, 0.1),
      s4: box(0.30, 0.1, 0.05, 0.1),
      s5: box(0.35, 0.1, 0.05, 0.1),
      s6: box(0.40, 0.1, 0.05, 0.1),
    }

    const wide = findWideStalls(d, 'V1', stalls)
    expect(wide).toHaveLength(1)
    expect(wide[0].stall.col).toBe(2)
    expect(wide[0].spaceIds).toEqual(['s2', 's3', 's4', 's5'])
  })

  it('normalizedStallWidth measures non-4-sided outlines as a width/depth ratio rather than raw area', () => {
    // 5-sided polygon: 0.05 wide, 0.1 deep with a clipped corner
    const pentagon: Point[] = [
      [0.1, 0.1],
      [0.14, 0.1],
      [0.15, 0.12],
      [0.15, 0.2],
      [0.1, 0.2],
    ]
    const ratio = normalizedStallWidth(pentagon, [1, 0])
    // Width is 0.05 (0.10 to 0.15), depth is 0.1 (0.10 to 0.20), ratio = 0.5
    expect(ratio).toBeCloseTo(0.5, 2)
  })
})


describe('rows laid out as wide as the photo shows them', () => {
  it('a row with a wide bay is laid out side by side, the bay a cell and a half, labels kept', () => {
    // The photo's row: stalls 0.05 wide, the third 0.075; on the map all five sit in one cell each with
    // a hole after the bay (where Find stalls put them).
    const xs = [0.1, 0.15, 0.2, 0.275, 0.325]
    const d = emptyDraft()
    d.spaces = xs.map((_, k) => space(`s${k}`, `C-0${k + 1}`, 20 + 50 * (k > 2 ? k + 1 : k), 20))
    d.viewpoints[0].outlines = Object.fromEntries(d.spaces.map((sp, k) => [sp.spaceId, box(xs[k], 0.1, (xs[k + 1] ?? xs[k] + 0.05) - xs[k], 0.1)]))
    const next = alignRowsToPhoto(d, 'V1')
    expect(next.spaces.map((sp) => [sp.label, sp.rect.x, sp.rect.w])).toEqual([
      ['C-01', 20, 50],
      ['C-02', 70, 50],
      ['C-03', 120, 75],
      ['C-04', 195, 50],
      ['C-05', 245, 50],
    ])
  })

  it('leaves rows of even stalls alone', () => {
    const d = emptyDraft()
    d.spaces = [0, 1, 2].map((k) => space(`s${k}`, `C-0${k + 1}`, 20 + 60 * k, 20))
    d.viewpoints[0].outlines = Object.fromEntries(d.spaces.map((sp, k) => [sp.spaceId, box(0.1 + 0.05 * k, 0.1, 0.05, 0.1)]))
    expect(alignRowsToPhoto(d, 'V1')).toBe(d)
  })
})

describe('stalls near an angled camera are not taken for wide bays', () => {
  /** A row of `n` stalls (those at `bays` 1.5 wide) seen by a camera at an angle: the ground mapped onto
   * the photo by a homography, so stalls nearer the camera (lower on the photo) look bigger. `flat`
   * looks straight down instead. */
  function obliqueRow(n: number, bays: number[] = [], flat = false): DraftLayout {
    const toPhoto = ([gx, gy]: Point): Point => {
      if (flat) return [0.1 + 0.6 * gx, 0.05 + 0.3 * gy]
      const w = 1 + 0.9 * gy
      return [(0.1 + 0.8 * gx) / w + 0.05, (0.9 - 0.1 * gy) / w - 0.25]
    }
    const d = emptyDraft()
    let at = 0
    d.spaces = Array.from({ length: n }, (_, k) => space(`s${k}`, `C-${String(k + 1).padStart(2, '0')}`, 20 + 50 * k, 20))
    d.viewpoints[0].outlines = Object.fromEntries(
      d.spaces.map((sp, k) => {
        const w = bays.includes(k) ? 0.15 : 0.1
        // The row runs from the camera's foot out across the lot (up the photo).
        const corners: Point[] = [[0.1, at], [0.1, at + w], [0.4, at + w], [0.4, at]]
        at += w
        return [sp.spaceId, corners.map(toPhoto) as Outline]
      }),
    )
    return d
  }

  it('a row whose stalls only grow towards the camera is left alone', () => {
    const d = obliqueRow(8)
    const areas = d.spaces.map((sp) => area(d.viewpoints[0].outlines[sp.spaceId] as Point[]))
    expect(areas[0] / areas[3]).toBeGreaterThan(1.4) // the old raw-area test called it a wide bay
    expect(alignRowsToPhoto(d, 'V1')).toBe(d)
  })

  it('still finds a bay half as wide again, near the camera too', () => {
    const next = alignRowsToPhoto(obliqueRow(8, [1]), 'V1')
    const widths = Object.fromEntries(next.spaces.map((sp) => [sp.label, sp.rect.w]))
    expect(widths['C-02']).toBe(75)
    expect(Object.entries(widths).filter(([l]) => l !== 'C-02').every(([, w]) => w === 50)).toBe(true)
  })

  it.each([
    ['overhead', [1, 2, 5], true],
    ['overhead', [1, 3, 5, 7], true],
    ['at an angle', [1, 4, 6], false],
    ['at an angle', [0, 3, 5, 8], false],
  ])('finds every bay when a row has several (%s, bays %j)', (_, bays, flat) => {
    const d = obliqueRow(10, bays, flat)
    const next = alignRowsToPhoto(d, 'V1')
    expect(next.spaces.map((sp) => sp.rect.w)).toEqual(d.spaces.map((_, k) => (bays.includes(k) ? 75 : 50)))
  })

  it('PKLot UFPR04: Find stalls on the straightened lot keeps every stall one cell wide', () => {
    const r = straightenFromPhoto(pklotFixture(), 'V1')
    if (typeof r === 'string') throw new Error(r)
    const cell = r.draft.spaces[0].rect.w
    const merged = mergeProposals(r.draft, 'V1', PKLOT_CAR_STALLS)
    const before = new Set(r.draft.spaces.map((sp) => sp.spaceId))
    const wider = merged.draft.spaces.filter((sp) => before.has(sp.spaceId) && sp.rect.w !== cell).map((sp) => `${sp.label} ${sp.rect.w}`)
    expect(wider).toEqual([])
  })

  it('an overhead photo (every stall drawn the same size) measures every stall as 1', () => {
    const sizes = groundSizes([0, 1, 2, 3].map((k) => box(0.1 + 0.05 * k, 0.1 + 0.2 * (k % 2), 0.05, 0.1)))
    for (const s of sizes) expect(s).toBeCloseTo(1, 6)
  })
})
