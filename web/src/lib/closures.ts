import type { ClosureOut, ClosureReason } from '../api/closures'
import { dateTime } from './relativeTime'

export const REASONS: { value: ClosureReason; label: string }[] = [
  { value: 'CONSTRUCTION', label: 'Construction' },
  { value: 'EVENT', label: 'Event' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'RESERVED', label: 'Reserved' },
]

export function reasonLabel(reason: ClosureReason): string {
  return REASONS.find((r) => r.value === reason)?.label ?? reason
}

/** "A" for "A-01"; null when a label has no "-" prefix. */
export function rowOf(label: string): string | null {
  const i = label.indexOf('-')
  return i > 0 ? label.slice(0, i) : null
}

/**
 * Labels in the given order, with runs of 3+ consecutive numbers under the same prefix
 * written as a range: ["B-01".."B-07", "A-02"] -> "B-01 to B-07, A-02".
 */
export function compactLabels(labels: string[]): string {
  const parts: string[] = []
  let run: { prefix: string; n: number; labels: string[] } | null = null
  const flush = () => {
    if (!run) return
    if (run.labels.length >= 3) parts.push(`${run.labels[0]} to ${run.labels[run.labels.length - 1]}`)
    else parts.push(...run.labels)
    run = null
  }
  for (const label of labels) {
    const m = /^(.*?)(\d+)$/.exec(label)
    if (m && run && run.prefix === m[1] && Number(m[2]) === run.n + 1) {
      run.n += 1
      run.labels.push(label)
      continue
    }
    flush()
    if (m) run = { prefix: m[1], n: Number(m[2]), labels: [label] }
    else parts.push(label)
  }
  flush()
  return parts.join(', ')
}

/** Display text for the server-computed status (never derived from the browser clock). */
export const STATUS_LABEL: Record<ClosureOut['status'], string> = {
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  ENDED: 'Ended',
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString()
}

function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** "Nov 7, 6:00 AM to 10:00 PM", "from Nov 7, 6:00 AM, open-ended", plus "; ended …". */
export function closureWindow(c: ClosureOut): string {
  let text: string
  if (c.endsAt) {
    const end = sameDay(new Date(c.startsAt), new Date(c.endsAt)) ? timeOnly(c.endsAt) : dateTime(c.endsAt)
    text = `${dateTime(c.startsAt)} to ${end}`
  } else {
    text = `from ${dateTime(c.startsAt)}, open-ended`
  }
  return c.endedAt ? `${text}; ended ${dateTime(c.endedAt)}` : text
}
