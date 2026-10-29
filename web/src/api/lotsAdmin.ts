import type { components } from './types.gen'

/** Short aliases for the generated admin lot and snapshot schemas (US-16, US-06). */
type S = components['schemas']
export type AdminLotOut = S['AdminLotOut']
export type AdminLotCreate = S['AdminLotCreate']
export type SnapshotOut = S['SnapshotOut']
export type JobStatus = SnapshotOut['jobStatus']
