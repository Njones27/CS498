import type { DraftLayout, DraftSpace } from '../types'
import { DEFAULT_SIZE, medianSize, placeNewSpace, rowRects, yBelowAll, type Size } from './geometry'
import { formatLabel, nextLabel, rowForNewSpace, spacesInRow, type ParsedLabel } from './labels'

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

/** + Space (US-07 #1): one standard space with the next unused label in the selected row (row A if none). */
export function addSpace(draft: DraftLayout, selectedSpaceId: string | null): { draft: DraftLayout; space: DraftSpace } {
  const row = rowForNewSpace(draft.spaces, selectedSpaceId)
  const inRow = spacesInRow(draft.spaces, row)
  const space: DraftSpace = {
    spaceId: newSpaceId(new Set(draft.spaces.map((s) => s.spaceId))),
    label: nextLabel(draft.spaces, row),
    type: 'STANDARD',
    rect: placeNewSpace(draft.spaces, inRow, sizeFor(draft.spaces, inRow), draft.schematic),
    retired: false,
  }
  return { draft: { ...draft, spaces: [...draft.spaces, space] }, space }
}

/** + Row (US-07 #2): `count` evenly spaced spaces labeled from `start` on one line below the lowest row. */
export function addRow(draft: DraftLayout, start: ParsedLabel, count: number): { draft: DraftLayout; spaces: DraftSpace[] } {
  const taken = new Set(draft.spaces.map((s) => s.spaceId))
  const size = medianSize(activeRects(draft.spaces)) ?? DEFAULT_SIZE
  const rects = rowRects(count, size, yBelowAll(draft.spaces), draft.schematic)
  const spaces = rects.map((rect, i): DraftSpace => {
    const spaceId = newSpaceId(taken)
    taken.add(spaceId)
    return { spaceId, label: formatLabel(start.row, start.num + i, start.digits), type: 'STANDARD', rect, retired: false }
  })
  return { draft: { ...draft, spaces: [...draft.spaces, ...spaces] }, spaces }
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
