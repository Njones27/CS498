import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LayoutOut } from '../api/schemas'
import { LotMapSvg } from './LotMapSvg'

const layout = (extra: Partial<LayoutOut['schematic']> = {}): LayoutOut => ({
  version: 1,
  schematic: { width: 400, height: 200, ...extra },
  spaces: [
    { spaceId: 'a', label: 'A-01', type: 'STANDARD', rect: { x: 20, y: 20, w: 40, h: 80 } },
    { spaceId: 'b', label: 'A-02', type: 'STANDARD', rect: { x: 60, y: 20, w: 40, h: 80 }, skewDeg: 45 },
  ],
})

function draw(l: LayoutOut) {
  render(<LotMapSvg layout={l} statusById={new Map()} selectedId={null} onSelect={() => {}} describe={(id) => id} />)
}

describe('driver lot map', () => {
  it('draws an angled stall leaning, a square one as a box, the row cut square at its end', () => {
    draw(layout())
    expect(screen.getByTestId('space-a').querySelector('rect.space__rect')).not.toBeNull()
    // B leans 45 degrees; the row ends at x 100, so its top overhang is cut off there.
    expect(screen.getByTestId('space-b').querySelector('polygon.space__rect')).toHaveAttribute('points', '100,20 100,60 60,100 20,100')
  })

  it('shows the map turned as the admin set it, labels upright, the compass turned with it', () => {
    draw(layout({ northDeg: 135, rotationDeg: 90 }))
    const svg = screen.getByRole('group', { name: 'Lot map' })
    expect(svg.querySelector('g')?.getAttribute('transform')).toBe('rotate(90 200 100)')
    expect(svg.getAttribute('viewBox')).toBe('100 -100 200 400')
    expect(screen.getByTestId('space-a').querySelector('g')?.getAttribute('transform')).toBe('rotate(-90 40 60)')
    // North was 135 degrees from map-up; the map turned a quarter more.
    expect(screen.getByRole('img', { name: 'North is 225° clockwise from up' })).toHaveClass('map-compass')
  })

  it('shows the compass only once north is set', () => {
    draw(layout())
    expect(screen.queryByTestId('compass')).not.toBeInTheDocument()
  })

  it('points the compass north', () => {
    draw(layout({ northDeg: 135 }))
    expect(screen.getByRole('img', { name: 'North is 135° clockwise from up' })).toBeInTheDocument()
  })

  it('selects a space on Enter and Space, and clears on Escape', () => {
    let selected: string | null = null
    render(
      <LotMapSvg
        layout={layout()}
        statusById={new Map()}
        selectedId={selected}
        onSelect={(id) => {
          selected = id
        }}
        describe={(id) => `Space ${id}`}
      />,
    )
    const spaceA = screen.getByTestId('space-a')
    spaceA.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(selected).toBe('a')

    spaceA.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(selected).toBeNull()

    const spaceB = screen.getByTestId('space-b')
    spaceB.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(selected).toBe('b')
  })
})
