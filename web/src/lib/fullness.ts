import type { LotSummary } from '../api/schemas'

export type FullnessLevel = 'plenty' | 'filling' | 'nearly-full' | 'no-data'

export interface Fullness {
  level: FullnessLevel
  label: string
}

/** US-15 thresholds: Plenty >= 30%, Filling up 10-29%, Nearly full < 10%. */
export function fullnessFor(openPercent: number | null): Fullness {
  if (openPercent === null) return { level: 'no-data', label: 'no recent data' }
  if (openPercent >= 30) return { level: 'plenty', label: 'Plenty' }
  if (openPercent >= 10) return { level: 'filling', label: 'Filling up' }
  return { level: 'nearly-full', label: 'Nearly full' }
}

export function summaryFullness(summary: LotSummary): Fullness {
  return fullnessFor(summary.hasRecentData ? summary.openPercent : null)
}
