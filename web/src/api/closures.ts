import type { components } from './types.gen'

/** Short aliases for the generated closure schemas (US-10). */
type S = components['schemas']
export type ClosureOut = S['ClosureOut']
export type ClosureCreate = S['ClosureCreate']
export type ClosureReason = S['ClosureReason']
