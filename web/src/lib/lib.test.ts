import { describe, expect, it } from 'vitest'
import { fullnessFor } from './fullness'
import { STATE_VISUALS, visualFor } from './status'
import { relativeTime } from './relativeTime'
import { sha256Hex } from './sha256'
import { resolveUploadUrl } from './putFile'

describe('fullnessFor', () => {
  it.each([
    [100, 'Plenty'],
    [30, 'Plenty'],
    [29.9, 'Filling up'],
    [10, 'Filling up'],
    [9.99, 'Nearly full'],
    [0, 'Nearly full'],
  ])('%s%% open -> %s', (pct, label) => {
    expect(fullnessFor(pct).label).toBe(label)
  })

  it('null percent means no recent data', () => {
    expect(fullnessFor(null)).toEqual({ level: 'no-data', label: 'no recent data' })
  })
})

describe('state visuals', () => {
  it('maps each state to a distinct icon', () => {
    expect(visualFor('FREE').icon).toBe('empty')
    expect(visualFor('OCCUPIED').icon).toBe('car')
    expect(visualFor('UNKNOWN').icon).toBe('unknown')
    expect(visualFor('CLOSED').icon).toBe('barrier')
    const icons = Object.values(STATE_VISUALS).map((v) => v.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-10-21T12:00:00Z')
  it('formats minutes', () => {
    expect(relativeTime('2026-10-21T11:55:00Z', now)).toBe('5 minutes ago')
    expect(relativeTime('2026-10-21T11:59:00Z', now)).toBe('1 minute ago')
  })
})

describe('sha256Hex', () => {
  it('hashes bytes to hex', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('resolveUploadUrl', () => {
  it('prepends base path to /api/ dev URLs when present', () => {
    const original = import.meta.env.BASE_URL
    try {
      import.meta.env.BASE_URL = '/proxy/5173/'
      expect(resolveUploadUrl('/api/_test/uploads/123')).toBe('/proxy/5173/api/_test/uploads/123')
    } finally {
      import.meta.env.BASE_URL = original
    }
  })

  it('leaves full http/https URLs untouched', () => {
    expect(resolveUploadUrl('https://s3.amazonaws.com/bucket/key')).toBe('https://s3.amazonaws.com/bucket/key')
  })
})
