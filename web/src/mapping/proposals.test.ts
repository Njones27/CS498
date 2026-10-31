import { describe, expect, it } from 'vitest'
import {
  acceptProposals,
  insidePolygon,
  mergeProposals,
  NEEDS_ANCHORS,
  pendingProposals,
  touchesPhotoEdge,
  rejectProposals,
  type ProposedStall,
} from './proposals'
import { fitGrid } from './schematic/grid'
import { photoToSchematic } from './sync'
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
