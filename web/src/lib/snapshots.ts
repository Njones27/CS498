import type { JobStatus, SnapshotOut } from '../api/lotsAdmin'

/** Statuses that can still change on their own; the Snapshots page polls while any row has one. */
export const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set(['UPLOAD_PENDING', 'QUEUED', 'PROCESSING'])

export const POLL_MS = 5000

export function isActive(s: Pick<SnapshotOut, 'jobStatus'>): boolean {
  return ACTIVE_STATUSES.has(s.jobStatus)
}

/** Retry only for a finished, failed job (US-06 #4); the API refuses anything else. */
export function canRetry(s: Pick<SnapshotOut, 'jobStatus' | 'finished'>): boolean {
  return s.jobStatus === 'FAILED' && s.finished
}

const STATUS_LABELS: Record<JobStatus, string> = {
  UPLOAD_PENDING: 'UPLOAD PENDING',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
  EXPIRED: 'Expired',
}

export function statusLabel(status: JobStatus): string {
  return STATUS_LABELS[status]
}

/** Processing time as "18 s" ("0.6 s" under ten seconds), or "-" when not processed. */
export function processingTime(ms: number | null): string {
  if (ms == null) return '-'
  const s = ms / 1000
  return s < 10 ? `${Number(s.toFixed(1))} s` : `${Math.round(s)} s`
}

/** The scorer name: `acpds_yolo|acpds=…|yolo=…` -> `acpds_yolo`; `stub-0` stays as is. */
export function modelName(modelVersion: string | null): string {
  if (!modelVersion) return '-'
  return modelVersion.split('|', 1)[0] || modelVersion
}

/** A 0..1 score with two decimals, or "-" when there is none (e.g. a space outside the photo). */
export function score(v: number | null | undefined): string {
  return v == null ? '-' : v.toFixed(2)
}
