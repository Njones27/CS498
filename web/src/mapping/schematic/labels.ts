import type { DraftSpace } from '../types'

/** A row-and-number label such as "B-04". The dash is optional when reading ("B4"). */
export interface ParsedLabel {
  row: string
  num: number
  digits: number
}

const LABEL_RE = /^([A-Za-z]+)-?(\d+)$/

/** "B-04" -> {row: "B", num: 4, digits: 2}; null for a label that isn't row-number. */
export function parseLabel(label: string): ParsedLabel | null {
  const m = LABEL_RE.exec(label.trim())
  if (!m) return null
  return { row: m[1].toUpperCase(), num: Number(m[2]), digits: m[2].length }
}

/** formatLabel("A", 8) -> "A-08". */
export function formatLabel(row: string, num: number, digits = 2): string {
  return `${row}-${String(num).padStart(digits, '0')}`
}

/** Labels compare trimmed and case-insensitive, as the server's duplicate_label rule does. */
export function normalizeLabel(label: string): string {
  return label.trim().toUpperCase()
}

/** Spaces whose label is in `row`, retired ones included (their labels stay used). */
export function spacesInRow(spaces: DraftSpace[], row: string): DraftSpace[] {
  return spaces.filter((s) => parseLabel(s.label)?.row === row)
}

/** The row + Space adds to: the selected space's row, or row A when nothing (or no row label) is selected. */
export function rowForNewSpace(spaces: DraftSpace[], selectedSpaceId: string | null): string {
  const selected = selectedSpaceId ? spaces.find((s) => s.spaceId === selectedSpaceId) : undefined
  return (selected && parseLabel(selected.label)?.row) || 'A'
}

/** The next unused label in `row`: the highest number used there plus 1, padded like the row (at least 2 digits). */
export function nextLabel(spaces: DraftSpace[], row: string): string {
  let max = 0
  let digits = 2
  for (const s of spacesInRow(spaces, row)) {
    const p = parseLabel(s.label)!
    max = Math.max(max, p.num)
    digits = Math.max(digits, p.digits)
  }
  return formatLabel(row, max + 1, digits)
}

/** A start label for + Row: the letter after the last single-letter row ("B-01" after row A), or "" after Z. */
export function nextRowStart(spaces: DraftSpace[]): string {
  let last = ''
  for (const s of spaces) {
    const row = parseLabel(s.label)?.row
    if (row && row.length === 1 && row > last) last = row
  }
  if (!last) return 'A-01'
  if (last === 'Z') return ''
  return formatLabel(String.fromCharCode(last.charCodeAt(0) + 1), 1)
}

/** Ids of active spaces whose (non-blank) label another active space also uses (US-07 #5). */
export function duplicateLabelIds(spaces: DraftSpace[]): Set<string> {
  const byLabel = new Map<string, string[]>()
  for (const s of spaces) {
    const key = normalizeLabel(s.label)
    if (s.retired || !key) continue
    byLabel.set(key, [...(byLabel.get(key) ?? []), s.spaceId])
  }
  const dup = new Set<string>()
  for (const ids of byLabel.values()) if (ids.length > 1) ids.forEach((id) => dup.add(id))
  return dup
}
