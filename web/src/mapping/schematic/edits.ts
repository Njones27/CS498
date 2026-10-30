import type { DraftLayout, DraftRect, DraftSpace } from '../types'
import { DEFAULT_SIZE, MARGIN, medianSize, placeNewSpace, roomFor, rowRects, yBelowAll, type Size } from './geometry'
import { formatLabel, labelForRect, nextLabel, rowForNewSpace, spacesInRow, type ParsedLabel } from './labels'

// Pure draft edits for the schematic editor. Each returns a new DraftLayout and leaves the input alone.

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A new space id: "sp_" + 8 random lowercase letters or digits (brief §4.1), not already in `taken`. */
export function newSpaceId(taken: ReadonlySet<string>): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const id = 'sp_' + Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('')
    if (!taken.has(id)) return id
  }
}

const activeRects = (spaces: DraftSpace[]) => spaces.filter((s) => !s.retired).map((s) => s.rect)

/** Size for a new space in `row`: the row's median rectangle, else the lot's, else DEFAULT_SIZE. */
function sizeFor(spaces: DraftSpace[], row: DraftSpace[]): Size {
  return medianSize(activeRects(row)) ?? medianSize(row.map((s) => s.rect)) ?? medianSize(activeRects(spaces)) ?? DEFAULT_SIZE
}

/** An edit's result, and how far it shifted every existing space to make room (fitSchematic). */
export interface Grown {
  draft: DraftLayout
  dx: number
  dy: number
}

/**
 * Grow the map area so every rectangle is inside it. Rectangles past the left or top edge shift
 * everything right or down by (dx, dy); the map never shrinks. Returns the input when nothing changes.
 */
export function fitSchematic(draft: DraftLayout): Grown {
  const rects = draft.spaces.map((s) => s.rect)
  if (rects.length === 0) return { draft, dx: 0, dy: 0 }
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const dx = minX < 0 ? Math.ceil(-minX) + MARGIN : 0
  const dy = minY < 0 ? Math.ceil(-minY) + MARGIN : 0
  const right = Math.max(...rects.map((r) => r.x + r.w)) + dx
  const bottom = Math.max(...rects.map((r) => r.y + r.h)) + dy
  let { width, height } = draft.schematic
  width += dx
  height += dy
  if (right > width) width = Math.ceil(right) + MARGIN
  if (bottom > height) height = Math.ceil(bottom) + MARGIN
  if (dx === 0 && dy === 0 && width === draft.schematic.width && height === draft.schematic.height) {
    return { draft, dx, dy }
  }
  const spaces = dx === 0 && dy === 0 ? draft.spaces : draft.spaces.map((s) => ({ ...s, rect: { ...s.rect, x: s.rect.x + dx, y: s.rect.y + dy } }))
  return { draft: { ...draft, schematic: { ...draft.schematic, width, height }, spaces }, dx, dy }
}

/** Append `spaces`, growing the map area to hold them (fitSchematic); they come back with their final rects. */
function appendSpaces(draft: DraftLayout, added: DraftSpace[]): Grown & { spaces: DraftSpace[] } {
  const { draft: next, dx, dy } = fitSchematic({ ...draft, spaces: [...draft.spaces, ...added] })
  return { draft: next, spaces: next.spaces.slice(draft.spaces.length), dx, dy }
}

/** + Space (US-07 #1): one standard space with the next unused label in the selected row (row A if none). */
export function addSpace(draft: DraftLayout, selectedSpaceId: string | null): Grown & { space: DraftSpace } {
  const row = rowForNewSpace(draft.spaces, selectedSpaceId)
  const inRow = spacesInRow(draft.spaces, row)
  const size = sizeFor(draft.spaces, inRow)
  const space: DraftSpace = {
    spaceId: newSpaceId(new Set(draft.spaces.map((s) => s.spaceId))),
    label: nextLabel(draft.spaces, row),
    type: 'STANDARD',
    // A full row or map gets room for one more space; appendSpaces grows the map to it.
    rect: placeNewSpace(draft.spaces, inRow, size, roomFor(draft.schematic, size)),
    retired: false,
  }
  const { spaces, ...grown } = appendSpaces(draft, [space])
  return { ...grown, space: spaces[0] }
}

/** A space drawn at `rect` (in the schematic or on a photo), labeled `label` or for the row it lines up with. */
export function addSpaceAt(draft: DraftLayout, rect: DraftRect, label?: string): Grown & { space: DraftSpace } {
  const { spaces, ...grown } = addSpacesAt(draft, [{ rect, label }])
  return { ...grown, space: spaces[0] }
}

/** Several spaces at once (one edit, one undo step), each labeled as given or for the row it lines up with. */
export function addSpacesAt(
  draft: DraftLayout,
  items: { rect: DraftRect; label?: string }[],
): Grown & { spaces: DraftSpace[] } {
  const taken = new Set(draft.spaces.map((s) => s.spaceId))
  const added: DraftSpace[] = []
  for (const { rect, label } of items) {
    const spaceId = newSpaceId(taken)
    taken.add(spaceId)
    // Later spaces see the earlier ones, so a run drawn in one go gets consecutive labels.
    const all = [...draft.spaces, ...added]
    added.push({ spaceId, label: label ?? labelForRect(all, rect), type: 'STANDARD', rect, retired: false })
  }
  return appendSpaces(draft, added)
}

/** + Row (US-07 #2): `count` evenly spaced spaces labeled from `start` on one line below the lowest row. */
export function addRow(draft: DraftLayout, start: ParsedLabel, count: number): Grown & { spaces: DraftSpace[] } {
  const taken = new Set(draft.spaces.map((s) => s.spaceId))
  const size = medianSize(activeRects(draft.spaces)) ?? DEFAULT_SIZE
  const y = yBelowAll(draft.spaces)
  // The map grows downward when the new line does not fit under the lowest row.
  const height = Math.max(draft.schematic.height, y + size.h + MARGIN)
  const rects = rowRects(count, size, y, { width: draft.schematic.width, height })
  const spaces = rects.map((rect, i): DraftSpace => {
    const spaceId = newSpaceId(taken)
    taken.add(spaceId)
    return { spaceId, label: formatLabel(start.row, start.num + i, start.digits), type: 'STANDARD', rect, retired: false }
  })
  return appendSpaces(draft, spaces)
}

/** Change one space's fields (label, type, rect, retired); its id never changes. */
export function updateSpace(draft: DraftLayout, spaceId: string, patch: Partial<Omit<DraftSpace, 'spaceId'>>): DraftLayout {
  return { ...draft, spaces: draft.spaces.map((s) => (s.spaceId === spaceId ? { ...s, ...patch } : s)) }
}

/** Remove a never-published space and its outlines in every viewpoint. */
export function deleteSpace(draft: DraftLayout, spaceId: string): DraftLayout {
  const without = <T,>(m: Record<string, T>): Record<string, T> => {
    if (!Object.hasOwn(m, spaceId)) return m
    const rest = { ...m }
    delete rest[spaceId]
    return rest
  }
  return {
    ...draft,
    spaces: draft.spaces.filter((s) => s.spaceId !== spaceId),
    viewpoints: draft.viewpoints.map((v) => ({
      ...v,
      outlines: without(v.outlines),
      outlineReview: without(v.outlineReview),
    })),
  }
}

/**
 * Delete is offered only for spaces that were never published (brief §6.1): every space of a lot
 * that was never published, otherwise any space not in `publishedIds`. Published spaces are retired.
 */
export function canDeleteSpace(spaceId: string, basedOnVersion: number | null, publishedIds: ReadonlySet<string>): boolean {
  return basedOnVersion === null || !publishedIds.has(spaceId)
}
