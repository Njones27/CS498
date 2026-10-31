import { describe, expect, it } from 'vitest'
import {
  acceptProposals,
  insidePolygon,
  mergeProposals,
  NEEDS_ANCHORS,
  pendingProposals,
  rejectProposals,
  type ProposedStall,
} from './proposals'
import { photoToSchematic } from './sync'
import type { DraftLayout, DraftSpace, Outline } from './types'

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
  return { polygon: box(x, y, 0.05, 0.1), evidence, row, col, mapRect: { x: col * 0.05, y: row * 0.15, w: 0.05, h: 0.1 } }
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
