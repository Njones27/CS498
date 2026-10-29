import type { components } from '../api/types.gen'

/** Mapping types shared by the mapping page and its panels (brief §4.4): aliases of the generated schemas. */
type S = components['schemas']
export type DraftLayout = S['DraftLayout']
export type DraftLayoutUpdate = S['DraftLayoutUpdate']
export type DraftSpace = S['DraftSpace']
export type DraftViewpoint = S['DraftViewpoint']
export type DraftRect = S['DraftRect']
export type OutlineReview = S['OutlineReviewOut']
export type ReferenceImage = S['ReferenceImageOut']
export type SpaceType = S['SpaceType']

/**
 * One validation problem (brief §4.3). Hand-written only until `POST .../layout/draft/validate` lands
 * with validation, which makes it `S['Issue']`; the shape here matches §4.3 exactly.
 */
export interface Issue {
  code: string
  message: string
  spaceIds: string[]
  viewId: string | null
}

/** Selection and hover shared by both panels. All callbacks are pure; panels never call the API for draft data. */
export interface MappingSelection {
  selectedSpaceId: string | null
  onSelectSpace: (spaceId: string | null) => void
  hoveredSpaceId: string | null // linked highlight between panels (US-08 #6)
  onHoverSpace: (spaceId: string | null) => void
}
