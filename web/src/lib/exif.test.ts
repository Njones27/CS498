import { describe, expect, it, vi } from 'vitest'
import { readCaptureTime } from './exif'

describe('readCaptureTime', () => {
  it('returns null for empty or invalid image blob', async () => {
    const blob = new Blob(['not an image'], { type: 'image/jpeg' })
    const time = await readCaptureTime(blob)
    expect(time).toBeNull()
  })

  it('parses valid Date from DateTimeOriginal', async () => {
    const fakeDate = new Date('2026-05-15T10:30:00Z')
    vi.doMock('exifr/dist/lite.esm.mjs', () => ({
      default: {
        parse: vi.fn().mockResolvedValue({ DateTimeOriginal: fakeDate }),
      },
    }))
    const blob = new Blob(['fake image data'], { type: 'image/jpeg' })
    const time = await readCaptureTime(blob)
    expect(time).toEqual(fakeDate)
    vi.doUnmock('exifr/dist/lite.esm.mjs')
  })

  it('parses date string from DateTimeOriginal', async () => {
    const dateStr = '2026-05-15T10:30:00Z'
    vi.doMock('exifr/dist/lite.esm.mjs', () => ({
      default: {
        parse: vi.fn().mockResolvedValue({ DateTimeOriginal: dateStr }),
      },
    }))
    const blob = new Blob(['fake image data'], { type: 'image/jpeg' })
    const time = await readCaptureTime(blob)
    expect(time).toEqual(new Date(dateStr))
    vi.doUnmock('exifr/dist/lite.esm.mjs')
  })

  it('returns null if parse rejects with an error', async () => {
    vi.doMock('exifr/dist/lite.esm.mjs', () => ({
      default: {
        parse: vi.fn().mockRejectedValue(new Error('Corrupt EXIF')),
      },
    }))
    const blob = new Blob(['corrupt image data'], { type: 'image/jpeg' })
    const time = await readCaptureTime(blob)
    expect(time).toBeNull()
    vi.doUnmock('exifr/dist/lite.esm.mjs')
  })
})
