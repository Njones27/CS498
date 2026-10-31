import type { components } from '../api/types.gen'
import { MARGIN, MIN_SIDE, yBelowAll } from './schematic/geometry'
import { addSpacesAt, deleteSpace, type Grown } from './schematic/edits'
import { formatLabel, nextRowStart, parseLabel } from './schematic/labels'
import { centroid, outlineToRect, photoToSchematic } from './sync'
import type { DraftLayout, DraftRect, DraftSpace, DraftViewpoint, OutlineReview, Outline, Point } from './types'

// Stalls found by the layout proposer (HDD §4.6), merged into the draft for review. Pure: every edit
// returns a new DraftLayout. A proposer stall becomes a new space with a pending proposed outline that
// carries its evidence score; the admin accepts or rejects it on the photo, weakest first.

export type ProposedStall = components['schemas']['ProposedStall']
export type ProposalRun = components['schemas']['ProposalRunOut']

/** A stall flattened onto the map is drawn at least this wide, at most this wide (schematic units). */
const MIN_STALL_W = 30
const MAX_STALL_W = 110

/** Why found stalls could not be added: the lot has spaces this photo cannot be matched to yet. */
export const NEEDS_ANCHORS =
  'Outline 4 of this lot\'s spaces on this photo first, so the stalls found can be matched to the spaces you already have.'

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

export interface MergeResult extends Grown {
  /** New spaces created for stalls. */
  added: number
  /** Stalls attached to a space the lot already had (outlined in another view, or on the map only). */
  attached: number
  /** Stalls left out: already outlined in this view, or not placeable on the map. */
  skipped: number
  /** Set when nothing was merged because the stalls cannot be matched to the lot's spaces. */
  blocked?: string
}

const contains = (r: DraftRect, [x, y]: Point) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

/**
 * Add the proposer's stalls to `viewId` as pending proposed outlines. Stalls on an outline already in the
 * view are skipped.
 *
 * With enough outlined spaces to fit the photo to the map, each stall is placed by the fit: one landing on
 * a space that has no outline in this view yet (seen from another viewpoint, or drawn on the map) becomes
 * that space's outline, and the rest become new spaces labeled for the row they line up with. Without a
 * fit, stalls can only be matched to nothing: on a lot whose spaces are all outlined here (a new lot,
 * typically) they become new spaces in the proposer's top-down layout, rows labeled A, B, C (after any rows
 * in use) and stalls 01 onward; on a lot with spaces this photo does not show yet, nothing is merged
 * (`blocked`), so a second viewpoint never duplicates the stalls of the first.
 */
export function mergeProposals(draft: DraftLayout, viewId: string, stalls: ProposedStall[]): MergeResult {
  const none = { draft, dx: 0, dy: 0, added: 0, attached: 0 }
  const view = draft.viewpoints.find((v) => v.viewId === viewId)
  if (!view) return { ...none, skipped: stalls.length }
  const fresh = stalls.filter((s) => !alreadyOutlined(view, s.polygon as Outline))
  let skipped = stalls.length - fresh.length
  if (fresh.length === 0) return { ...none, skipped }

  const unmatched = draft.spaces.filter((sp) => !sp.retired && !view.outlines[sp.spaceId])
  const fit = photoToSchematic(draft, view)
  if (!fit && unmatched.length > 0) return { ...none, skipped, blocked: NEEDS_ANCHORS }

  // Stalls for spaces the lot already has, and the rest with their rect and label.
  const attach = new Map<string, ProposedStall>()
  const create: { stall: ProposedStall; rect: DraftRect; label?: string }[] = []
  if (fit) {
    const free = new Set(unmatched.map((sp) => sp.spaceId))
    for (const stall of fresh) {
      const rect = outlineToRect(fit, stall.polygon as Outline)
      if (!rect) {
        skipped++
        continue
      }
      const mid: Point = [rect.x + rect.w / 2, rect.y + rect.h / 2]
      const space: DraftSpace | undefined = unmatched.find((sp) => free.has(sp.spaceId) && contains(sp.rect, mid))
      if (space) {
        free.delete(space.spaceId)
        attach.set(space.spaceId, stall)
      } else {
        create.push({ stall, rect })
      }
    }
  } else {
    const rects = layoutRects(draft, fresh)
    const labels = layoutLabels(draft, fresh)
    fresh.forEach((stall, i) => create.push({ stall, rect: rects[i], label: labels[i] }))
  }

  const grown = addSpacesAt(
    draft,
    create.map(({ rect, label }) => ({ rect, label })),
  )
  const found = new Map(attach)
  grown.spaces.forEach((space, i) => found.set(space.spaceId, create[i].stall))
  const outlines = { ...view.outlines }
  const outlineReview: Record<string, OutlineReview> = { ...view.outlineReview }
  for (const [spaceId, stall] of found) {
    outlines[spaceId] = stall.polygon as Outline
    outlineReview[spaceId] = { source: 'proposed', status: 'pending', evidence: stall.evidence }
    if (!attach.has(spaceId)) outlineReview[spaceId].newSpace = true
  }
  const next: DraftLayout = {
    ...grown.draft,
    viewpoints: grown.draft.viewpoints.map((v) => (v.viewId === viewId ? { ...v, outlines, outlineReview } : v)),
  }
  return { draft: next, dx: grown.dx, dy: grown.dy, added: create.length, attached: attach.size, skipped }
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
 * Reject proposed outlines in `viewId`. A space the proposer created for its stall (`newSpace`) that has
 * no outline in any other view is not a real space, so it goes too; it was never published, since its
 * pending outline blocked publishing. Every other space keeps everything but this outline.
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
    const elsewhere = next.viewpoints.some((v) => v.viewId !== viewId && v.outlines[id])
    if (review?.status === 'pending' && review.newSpace && !elsewhere) {
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
