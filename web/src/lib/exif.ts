/** EXIF DateTimeOriginal, or null when the photo has none or cannot be parsed. */
export async function readCaptureTime(file: Blob): Promise<Date | null> {
  try {
    const exifr = (await import('exifr/dist/lite.esm.mjs')).default
    const tags = (await exifr.parse(file, ['DateTimeOriginal'])) as
      | { DateTimeOriginal?: Date | string }
      | undefined
    const v = tags?.DateTimeOriginal
    if (!v) return null
    const d = v instanceof Date ? v : new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}
