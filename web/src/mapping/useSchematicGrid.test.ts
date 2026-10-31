import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { davidFixture, space } from './fixtures/david'
import { gridSizes } from './schematic/grid'
import { uniformShift, useSchematicGrid } from './useSchematicGrid'

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

describe('useSchematicGrid', () => {
  it('fits the grid again when an empty lot gets its first spaces (found stalls)', () => {
    localStorage.clear()
    const empty = davidFixture({ spaces: [] })
    const { result, rerender } = renderHook(({ d }) => useSchematicGrid('lot-x', d), { initialProps: { d: empty } })
    const before = result.current!.grid
    const small = { label: '', rect: { x: 0, y: 0, w: 40, h: 80 } }
    const found = davidFixture({
      spaces: [
        space('a', 0, 0, { ...small, label: 'A-01', rect: { x: 20, y: 20, w: 40, h: 80 } }),
        space('b', 0, 0, { ...small, label: 'A-02', rect: { x: 60, y: 20, w: 40, h: 80 } }),
      ],
    })
    rerender({ d: { ...found, lotId: empty.lotId, basedOnVersion: empty.basedOnVersion } })
    const after = result.current!.grid
    expect(after).not.toEqual(before)
    expect(gridSizes(after).boxW).toBeLessThan(gridSizes(before).boxW)
  })
})
