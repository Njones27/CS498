import type { components } from './types.gen'

/** Short aliases for the generated OpenAPI schemas. Never hand-write response shapes. */
type S = components['schemas']
export type ErrorResponse = S['ErrorResponse']
export type LoginRequest = S['LoginRequest']
export type LoginResponse = S['LoginResponse']
export type LotListItem = S['LotListItem']
export type LotSummary = S['LotSummary']
export type LotDetail = S['LotDetail']
export type LayoutOut = S['LayoutOut']
export type LotStatusOut = S['LotStatusOut']
export type SpaceStatusOut = S['SpaceStatusOut']
export type SpaceState = S['SpaceState']
export type UploadRequest = S['UploadRequest']
export type UploadSlot = S['UploadSlot']
export type UploadCompleteResponse = S['UploadCompleteResponse']
