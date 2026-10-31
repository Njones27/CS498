import type { components } from './types.gen'

/** Short aliases for the generated admin state override schemas. */
type S = components['schemas']
export type OverrideOut = S['OverrideOut']
export type OverrideCreate = S['OverrideCreate']
export type OverrideInfo = S['OverrideInfo']
export type OverrideState = OverrideCreate['state']
