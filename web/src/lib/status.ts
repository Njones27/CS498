import type { SpaceState } from '../api/schemas'

export type StateIcon = 'empty' | 'car' | 'unknown' | 'barrier'

export interface StateVisual {
  icon: StateIcon
  /** Plain-language name used in the legend, tooltip and summary bar. */
  label: string
  /** CSS class on the space; the fill/pattern differs per state, not only the color (NFR-8). */
  className: string
}

export const STATE_VISUALS: Record<SpaceState, StateVisual> = {
  FREE: { icon: 'empty', label: 'Free', className: 'space--free' },
  OCCUPIED: { icon: 'car', label: 'Occupied', className: 'space--occupied' },
  UNKNOWN: { icon: 'unknown', label: 'Unknown', className: 'space--unknown' },
  CLOSED: { icon: 'barrier', label: 'Closed', className: 'space--closed' },
}

export const STATE_ORDER: SpaceState[] = ['FREE', 'OCCUPIED', 'UNKNOWN', 'CLOSED']

export function visualFor(state: SpaceState): StateVisual {
  return STATE_VISUALS[state]
}
