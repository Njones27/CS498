import type { components } from '../api/types.gen'
import type { Grid } from './schematic/grid'

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

export type ReferenceUploadSlot = S['ReferenceUploadSlot']
export type ReferenceCompleteResponse = S['ReferenceCompleteResponse']

/** A reference photo the client just stored: the `complete` response, plus the lot it belongs to. */
export interface UploadedReference {
  lotId: string
  viewId: string
  referenceImage: ReferenceImage
}

export type Point = [number, number]
export type Outline = Point[]

/** One validation problem (brief §4.3): `code`, `message`, `spaceIds`, `viewId`. */
export type Issue = S['Issue']
export type ValidationReport = S['ValidationReport']
export type LayoutVersionOut = S['LayoutVersionOut']

/** Selection and hover shared by both panels. All callbacks are pure; panels never call the API for draft data. */
export interface MappingSelection {
  selectedSpaceId: string | null
  onSelectSpace: (spaceId: string | null) => void
  hoveredSpaceId: string | null // linked highlight between panels (US-08 #6)
  onHoverSpace: (spaceId: string | null) => void
}

export interface ReferencePhotoPanelProps extends MappingSelection {
  lotId: string
  draft: DraftLayout
  viewId: string | null
  onViewChange: (viewId: string) => void
  onChange: (next: DraftLayout) => void
  /** Refetch the reference photos (with fresh signed URLs) into the page's latest draft: after an
   * upload, which passes the stored photo so it shows at once, and to retry a photo that did not load. */
  onReferenceUploaded: (uploaded?: UploadedReference) => void
  issues: Issue[]
  onSave?: () => Promise<DraftLayout | null>
  /** The schematic grid while snapping is on: spaces added or moved from the photo land in its cells. */
  snapGrid?: Grid | null
}
