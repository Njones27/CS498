import type { OverrideInfo, OverrideOut, OverrideState } from '../api/overrides'
import { dateTime } from './relativeTime'

export const OVERRIDE_STATES: { value: OverrideState; label: string }[] = [
  { value: 'FREE', label: 'Free' },
  { value: 'OCCUPIED', label: 'Occupied' },
]

export function overrideStateLabel(state: OverrideState): string {
  return OVERRIDE_STATES.find((s) => s.value === state)?.label ?? state
}

function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** "3:00 PM" when `iso` falls on the same local day as `ref`, else "Nov 7, 3:00 PM". */
export function timeOrDateTime(iso: string, ref: Date = new Date()): string {
  return new Date(iso).toDateString() === ref.toDateString() ? timeOnly(iso) : dateTime(iso)
}

/** Driver-facing note for a space an admin set: "Set by admin until 3:00 PM" or "Set by admin". */
export function setByAdminText(override: OverrideInfo | null | undefined, now: Date = new Date()): string {
  return override?.endsAt ? `Set by admin until ${timeOrDateTime(override.endsAt, now)}` : 'Set by admin'
}

/** "Oct 31, 2:00 PM to 3:00 PM", "from Oct 31, 2:00 PM, until ended", plus "; ended …". */
export function overrideWindow(o: Pick<OverrideOut, 'startsAt' | 'endsAt' | 'endedAt'>): string {
  let text: string
  if (o.endsAt) text = `${dateTime(o.startsAt)} to ${timeOrDateTime(o.endsAt, new Date(o.startsAt))}`
  else text = `from ${dateTime(o.startsAt)}, until ended`
  return o.endedAt ? `${text}; ended ${dateTime(o.endedAt)}` : text
}
