import { describe, expect, it } from 'vitest'
import { davidFixture, space } from './fixtures/david'
import { uniformShift } from './useSchematicGrid'

describe('uniformShift', () => {
  it('finds the shift every space took when the map grew left or up', () => {
    const a = davidFixture()
    const b = {
      ...a,
      schematic: { width: 1050, height: 630 },
      spaces: a.spaces.map((s) => ({ ...s, rect: { ...s.rect, x: s.rect.x + 50, y: s.rect.y + 30 } })),
    }
    expect(uniformShift(a, b)).toEqual({ dx: 50, dy: 30 })
    expect(uniformShift(b, a)).toEqual({ dx: -50, dy: -30 }) // undo
  })

  it('tolerates floating-point noise in the deltas', () => {
    const a = davidFixture({ spaces: [space('p', 0.1, 0.7), space('q', 32.47, 81.13), space('r', 1.03, 9.99)] })
    const b = {
      ...a,
      schematic: { width: 1020, height: 600 },
      spaces: a.spaces.map((s) => ({ ...s, rect: { ...s.rect, x: s.rect.x + 20.2 } })),
    }
    expect(uniformShift(a, b)).toEqual({ dx: 20.2, dy: 0 })
  })

  it('is null when the map size is unchanged, or the spaces did not move together', () => {
    const a = davidFixture()
    const moved = { ...a, spaces: a.spaces.map((s, i) => (i === 0 ? { ...s, rect: { ...s.rect, x: 900 } } : s)) }
    expect(uniformShift(a, moved)).toBeNull()
    const grown = { ...moved, schematic: { width: 1080, height: 600 } }
    expect(uniformShift(a, grown)).toBeNull()
  })
})
