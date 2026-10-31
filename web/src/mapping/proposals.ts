import type { components } from '../api/types.gen'
import { MARGIN, MIN_SIDE, yBelowAll } from './schematic/geometry'
import { addSpacesAt, deleteSpace, type Grown } from './schematic/edits'
import { formatLabel, nextRowStart, parseLabel } from './schematic/labels'
import { outlineToRect, photoToSchematic } from './sync'
import type { DraftLayout, DraftRect, DraftViewpoint, OutlineReview, Outline, Point } from './types'

// Stalls found by the layout proposer (HDD §4.6), merged into the draft for review. Pure: every edit
// returns a new DraftLayout. A proposer stall becomes a new space with a pending proposed outline that
// carries its evidence score; the admin accepts or rejects it on the photo, weakest first.

export type ProposedStall = components['schemas']['ProposedStall']
export type ProposalRun = components['schemas']['ProposalRunOut']

/** A stall flattened onto the map is drawn at least this wide, at most this wide (schematic units). */
const MIN_STALL_W = 30
const MAX_STALL_W = 110

const centroid = (pts: Point[]): Point => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
]

/** Ray casting: is `p` inside the polygon? */
export function insidePolygon([x, y]: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** A stall that lands on an outline already in the view (either one's middle inside the other). */
function alreadyOutlined(view: DraftViewpoint, stall: Outline): boolean {
  const mid = centroid(stall)
  return Object.values(view.outlines).some((o) => insidePolygon(mid, o) || insidePolygon(centroid(o), stall))
}

/** Rects for a lot with too few outlines to place by the photo fit: the proposer's top-down layout,
 * scaled to fit the map's width (within a sensible stall size), under any spaces already there. */
function layoutRects(draft: DraftLayout, stalls: ProposedStall[]): DraftRect[] {
  const width = Math.max(...stalls.map((s) => s.mapRect.x + s.mapRect.w))
  const widths = stalls.map((s) => s.mapRect.w).sort((a, b) => a - b)
  const stallW = widths[Math.floor(widths.length / 2)]
  let scale = (draft.schematic.width - 2 * MARGIN) / width
  scale = Math.min(Math.max(scale, MIN_STALL_W / stallW), MAX_STALL_W / stallW)
  const x0 = MARGIN
  const y0 = draft.spaces.length > 0 ? yBelowAll(draft.spaces) : MARGIN
  return stalls.map(({ mapRect: r }) => {
    // Edges are rounded, not sizes, so neighbours that touch on the photo touch on the map.
    const left = Math.round(x0 + r.x * scale)
    const top = Math.round(y0 + r.y * scale)
    const right = Math.round(x0 + (r.x + r.w) * scale)
    const bottom = Math.round(y0 + (r.y + r.h) * scale)
    return { x: left, y: top, w: Math.max(MIN_SIDE, right - left), h: Math.max(MIN_SIDE, bottom - top) }
  })
}

/** Labels for a new lot's stalls: proposer rows become the next free row letters, top to bottom, and
 * stalls are numbered 01 onward left to right. Undefined past Z (the label then follows the map). */
function layoutLabels(draft: DraftLayout, stalls: ProposedStall[]): (string | undefined)[] {
  const first = parseLabel(nextRowStart(draft.spaces))?.row
  const rows = [...new Set(stalls.map((s) => s.row))].sort((a, b) => a - b)
  const letter = new Map(
    rows.map((row, i) => {
      const code = first && first.length === 1 ? first.charCodeAt(0) + i : NaN
      return [row, code <= 'Z'.charCodeAt(0) ? String.fromCharCode(code) : undefined]
    }),
  )
  const order = new Map<ProposedStall, number>()
  for (const row of rows) {
    stalls
      .filter((s) => s.row === row)
      .sort((a, b) => a.mapRect.x - b.mapRect.x)
      .forEach((s, i) => order.set(s, i + 1))
  }
  return stalls.map((s) => {
    const row = letter.get(s.row)
    return row ? formatLabel(row, order.get(s)!) : undefined
  })
}

/**
 * Add the proposer's stalls to `viewId` as new spaces with pending proposed outlines. Stalls on an outline
 * already in the view are skipped. With enough outlined spaces to fit the photo to the map, new rects go
 * where the fit puts them and take the label of the row they line up with; on a new lot they follow the
 * proposer's top-down layout with rows labeled A, B, C (after any rows in use) and stalls 01 onward.
 */
export function mergeProposals(
  draft: DraftLayout,
  viewId: string,
  stalls: ProposedStall[],
): Grown & { added: number; skipped: number } {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) return { draft, dx: 0, dy: 0, added: 0, skipped: stalls.length }
  const fresh = stalls.filter((s) => !alreadyOutlined(view, s.polygon as Outline))
  const skipped = stalls.length - fresh.length
  if (fresh.length === 0) return { draft, dx: 0, dy: 0, added: 0, skipped }

  const fit = photoToSchematic(draft, view)
  const fitted = fit ? fresh.map((s) => outlineToRect(fit, s.polygon as Outline)) : []
  const byFit = fit !== null && fitted.every((r) => r !== null)
  const rects = byFit ? (fitted as DraftRect[]) : layoutRects(draft, fresh)
  const labels = byFit ? fresh.map(() => undefined) : layoutLabels(draft, fresh)

  const grown = addSpacesAt(
    draft,
    rects.map((rect, i) => ({ rect, label: labels[i] })),
  )
  const outlines = { ...view.outlines }
  const outlineReview: Record<string, OutlineReview> = { ...view.outlineReview }
  grown.spaces.forEach((space, i) => {
    outlines[space.spaceId] = fresh[i].polygon as Outline
    outlineReview[space.spaceId] = { source: 'proposed', status: 'pending', evidence: fresh[i].evidence }
  })
  const next: DraftLayout = {
    ...grown.draft,
    viewpoints: grown.draft.viewpoints.map((v) => (v.viewId === viewId ? { ...v, outlines, outlineReview } : v)),
  }
  return { draft: next, dx: grown.dx, dy: grown.dy, added: fresh.length, skipped }
}

/** The view's outlines still waiting for review, weakest evidence first (those without a score last). */
export function pendingProposals(view: DraftViewpoint): { spaceId: string; evidence: number | null }[] {
  return Object.entries(view.outlineReview ?? {})
    .filter(([sid, r]) => r.status === 'pending' && view.outlines[sid])
    .map(([spaceId, r]) => ({ spaceId, evidence: r.evidence ?? null }))
    .sort((a, b) => (a.evidence ?? Infinity) - (b.evidence ?? Infinity) || a.spaceId.localeCompare(b.spaceId))
}

/** Words for an evidence score, so the review list reads without the number. */
export function evidenceWord(evidence: number | null): string {
  if (evidence === null) return 'From the map'
  if (evidence < 0.4) return 'Weak'
  if (evidence < 0.7) return 'Fair'
  return 'Strong'
}

/** Accept proposed outlines in `viewId`: they stay as they are, reviewed. */
export function acceptProposals(draft: DraftLayout, viewId: string, spaceIds: string[]): DraftLayout {
  return {
    ...draft,
    viewpoints: draft.viewpoints.map((v) => {
      if (v.viewId !== viewId) return v
      const outlineReview = { ...v.outlineReview }
      for (const id of spaceIds) {
        const r = outlineReview[id]
        if (r?.status === 'pending') outlineReview[id] = { ...r, status: 'accepted' }
      }
      return { ...v, outlineReview }
    }),
  }
}

/**
 * Reject proposed outlines in `viewId`. A stall the proposer found (it carries evidence) that has no
 * outline in any other view is not a real space, so the space goes too; it was never published, since a
 * pending outline blocks publishing. Other spaces keep everything but this outline.
 */
export function rejectProposals(
  draft: DraftLayout,
  viewId: string,
  spaceIds: string[],
): { draft: DraftLayout; removedSpaces: number } {
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) return { draft, removedSpaces: 0 }
  let next = draft
  let removedSpaces = 0
  for (const id of spaceIds) {
    const review = view.outlineReview?.[id]
    const fromProposer = review?.source === 'proposed' && review.evidence != null
    const elsewhere = next.viewpoints.some((v) => v.viewId !== viewId && v.outlines[id])
    if (fromProposer && !elsewhere) {
      next = deleteSpace(next, id)
      removedSpaces++
      continue
    }
    next = {
      ...next,
      viewpoints: next.viewpoints.map((v) => {
        if (v.viewId !== viewId) return v
        const { [id]: _o, ...outlines } = v.outlines
        const { [id]: _r, ...outlineReview } = v.outlineReview ?? {}
        return { ...v, outlines, outlineReview }
      }),
    }
  }
  return { draft: next, removedSpaces }
}
