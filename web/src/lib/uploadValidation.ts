import type { UploadRequest } from '../api/schemas'

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
export const ACCEPTED_TYPES: UploadRequest['contentType'][] = ['image/jpeg', 'image/png']

export const WRONG_TYPE_MESSAGE = 'Only JPEG or PNG photos are accepted'
export const TOO_LARGE_MESSAGE = 'Photos must be 15 MB or smaller'
export const FUTURE_TIME_MESSAGE = 'Capture time cannot be in the future'

export function isAcceptedType(type: string): type is UploadRequest['contentType'] {
  return (ACCEPTED_TYPES as string[]).includes(type)
}

/** US-04 file checks; returns the user-facing message or null when the file is fine. */
export function validateFile(file: File): string | null {
  if (!isAcceptedType(file.type)) return WRONG_TYPE_MESSAGE
  if (file.size > MAX_UPLOAD_BYTES) return TOO_LARGE_MESSAGE
  return null
}

/** Parses a datetime-local value (local time); null when empty or invalid. */
export function parseLocalDateTime(value: string): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}
