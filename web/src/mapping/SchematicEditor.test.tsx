import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { davidFixture, space } from './fixtures/david'
import { pklotFixture } from './fixtures/pklot'
import { SchematicEditor } from './SchematicEditor'
import { useSchematicGrid } from './useSchematicGrid'
import type { DraftLayout, DraftSpace, Issue } from './types'

interface Options {
  draft?: DraftLayout
  selectedSpaceId?: string | null
  issues?: Issue[]
  publishedSpaceIds?: ReadonlySet<string>
  withGrid?: boolean // the page's grid (useSchematicGrid), snapping on unless a test turns it off
  photoViewId?: string | null
}

/** Render the editor alone, holding draft, selection and hover in state like the mapping page does. */
function setup({ draft = davidFixture(), selectedSpaceId = null, issues = [], publishedSpaceIds, withGrid = false, photoViewId = null }: Options = {}) {
  const onChange = vi.fn<(next: DraftLayout) => void>()
  const onSelectSpace = vi.fn<(id: string | null) => void>()
  const onHoverSpace = vi.fn<(id: string | null) => void>()
  function Harness() {
    const [d, setD] = useState(draft)
    const [selected, setSelected] = useState(selectedSpaceId)
    const [hovered, setHovered] = useState<string | null>(null)
    const grid = useSchematicGrid('test-lot', d)
    return (
      <SchematicEditor
        draft={d}
        grid={withGrid ? grid : undefined}
        photoViewId={photoViewId}
        onChange={(next, shift) => {
          onChange(next)
          // As the mapping page does: an edit that shifted every space moves the grid with them.
          if (shift) grid?.shiftBy(next, shift.dx, shift.dy)
          setD(next)
        }}
        issues={issues}
        publishedSpaceIds={publishedSpaceIds}
        selectedSpaceId={selected}
        onSelectSpace={(id) => {
          onSelectSpace(id)
          setSelected(id)
        }}
        hoveredSpaceId={hovered}
        onHoverSpace={(id) => {
          onHoverSpace(id)
          setHovered(id)
        }}
      />
    )
  }
  render(<Harness />)
  const last = () => onChange.mock.lastCall![0]
  return { onChange, onSelectSpace, onHoverSpace, last, user: userEvent.setup() }
}

const spaceEl = (id: string) => screen.getByTestId(`schematic-space-${id}`)
const rectOf = (d: DraftLayout, id: string) => d.spaces.find((s) => s.spaceId === id)!.rect
const byId = (d: DraftLayout, id: string) => d.spaces.find((s) => s.spaceId === id)!
const panel = () => screen.getByRole('group', { name: 'Selected space' })

/** Press on `el`, move the pointer by (dx, dy) screen pixels and release. Units equal pixels in jsdom. */
function drag(el: Element, dx: number, dy: number) {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 100, button: 0 })
  fireEvent.pointerMove(window, { clientX: 100 + dx / 2, clientY: 100 + dy / 2 })
  fireEvent.pointerMove(window, { clientX: 100 + dx, clientY: 100 + dy })
  fireEvent.pointerUp(window, { clientX: 100 + dx, clientY: 100 + dy })
}

describe('SchematicEditor', () => {
  it('renders one labeled rectangle per space in the schematic viewBox, with type badges and retired marker', () => {
    setup()
    const svg = screen.getByRole('group', { name: 'Schematic editor' })
    // The whole map plus a 6% margin to drag into.
    expect(svg).toHaveAttribute('viewBox', '-60 -60 1120 720')
    expect(screen.getByRole('button', { name: 'A-01, standard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'A-02, ADA' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'A-04, EV' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'A-05, standard, retired' })).toBeInTheDocument()
    expect(within(spaceEl('A-02')).getByText('ADA')).toBeInTheDocument()
    expect(within(spaceEl('A-04')).getByText('EV')).toBeInTheDocument()
    expect(within(spaceEl('A-01')).queryByText('ADA')).toBeNull()
    expect(within(spaceEl('A-05')).getByText('Retired')).toBeInTheDocument()
    expect(spaceEl('A-05')).toHaveClass('schematic-space--retired')
    const rect = spaceEl('A-03').querySelector('rect')!
    expect([rect.getAttribute('x'), rect.getAttribute('y'), rect.getAttribute('width'), rect.getAttribute('height')]).toEqual([
      '260',
      '40',
      '100',
      '120',
    ])
    expect(screen.getByRole('region', { name: 'Schematic' })).toHaveTextContent('4 spaces, 1 retired')
  })

  it('US-07 #1: + Space appends one space with the next unused label', async () => {
    const { onChange, onSelectSpace, last, user } = setup()
    await user.click(screen.getByRole('button', { name: '+ Space' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = last()
    expect(next.spaces).toHaveLength(6)
    expect(next.spaces.slice(0, 5)).toEqual(davidFixture().spaces)
    const added = next.spaces[5]
    // A-05 is retired but its label is still used, so the next unused label is A-06.
    expect(added).toMatchObject({ label: 'A-06', type: 'STANDARD', retired: false })
    expect(added.spaceId).toMatch(/^sp_[a-z0-9]{8}$/)
    expect(added.rect).toEqual({ x: 590, y: 40, w: 100, h: 120 }) // the row's median size, right of the row
    expect(onSelectSpace).toHaveBeenLastCalledWith(added.spaceId)
    expect(screen.getByRole('button', { name: 'A-06, standard' })).toBeInTheDocument()
    expect(screen.getByText('Added A-06')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '+ Space' }))
    expect(last().spaces[6].label).toBe('A-07')
  })

  it('US-07 #1: + Space adds to the selected space row', async () => {
    const draft = davidFixture({ spaces: [...davidFixture().spaces, space('B-03', 40, 200), space('B-07', 150, 200)] })
    const { last, user } = setup({ draft, selectedSpaceId: 'B-03' })
    await user.click(screen.getByRole('button', { name: '+ Space' }))
    expect(last().spaces.at(-1)).toMatchObject({ label: 'B-08', rect: { x: 260, y: 200, w: 100, h: 120 } })
  })

  it('US-07 #2: + Row 10 from B-01 gives B-01 to B-10, evenly spaced on one line', async () => {
    const { onChange, last, user } = setup()
    await user.click(screen.getByRole('button', { name: '+ Row' }))
    const dialog = screen.getByRole('dialog', { name: 'Add a row' })
    const start = within(dialog).getByLabelText('Start label')
    expect(start).toHaveValue('B-01')
    await user.clear(start)
    await user.type(start, 'B-01')
    const count = within(dialog).getByLabelText('Number of spaces')
    await user.clear(count)
    await user.type(count, '10')
    await user.click(within(dialog).getByRole('button', { name: 'Add row' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const added = last().spaces.slice(5)
    expect(added.map((s) => s.label)).toEqual(['B-01', 'B-02', 'B-03', 'B-04', 'B-05', 'B-06', 'B-07', 'B-08', 'B-09', 'B-10'])
    expect(new Set(added.map((s) => s.spaceId)).size).toBe(10)
    added.forEach((s) => expect(s.spaceId).toMatch(/^sp_[a-z0-9]{8}$/))
    // One line, below the lowest row (A ends at y 160), all the same size, equal steps, inside the map.
    expect(new Set(added.map((s) => s.rect.y)).size).toBe(1)
    expect(added[0].rect.y).toBeGreaterThanOrEqual(160)
    expect(new Set(added.map((s) => `${s.rect.w}x${s.rect.h}`)).size).toBe(1)
    const steps = added.slice(1).map((s, i) => s.rect.x - added[i].rect.x)
    expect(new Set(steps).size).toBe(1)
    expect(steps[0]).toBeGreaterThan(added[0].rect.w)
    expect(added.every((s) => s.rect.x >= 0 && s.rect.x + s.rect.w <= 1000 && s.rect.y + s.rect.h <= 600)).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Added B-01 to B-10')).toBeInTheDocument()
  })

  it('+ Row rejects a bad start label or count and adds nothing', async () => {
    const { onChange, user } = setup()
    await user.click(screen.getByRole('button', { name: '+ Row' }))
    const start = screen.getByLabelText('Start label')
    await user.clear(start)
    await user.type(start, 'Gate')
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a start label like B-01')

    await user.clear(start)
    await user.type(start, 'B-01')
    const count = screen.getByLabelText('Number of spaces')
    await user.clear(count)
    await user.type(count, '0')
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number of spaces from 1 to 48')
    expect(onChange).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('US-07 #3: dragging a space emits its new rect once, on pointer up', () => {
    const { onChange, onSelectSpace, last } = setup()
    fireEvent.pointerDown(spaceEl('A-03'), { clientX: 100, clientY: 100, button: 0 })
    expect(onSelectSpace).toHaveBeenLastCalledWith('A-03')
    fireEvent.pointerMove(window, { clientX: 125, clientY: 110 })
    fireEvent.pointerMove(window, { clientX: 150, clientY: 130 })
    // The rectangle follows the pointer, but nothing is emitted until release.
    expect(spaceEl('A-03').querySelector('rect')).toHaveAttribute('x', '310')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(window, { clientX: 150, clientY: 130 })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(rectOf(last(), 'A-03')).toEqual({ x: 310, y: 70, w: 100, h: 120 })
    expect(rectOf(last(), 'A-01')).toEqual(rectOf(davidFixture(), 'A-01'))
  })

  it('US-07 #3: dragging a corner handle resizes the space', () => {
    const { onChange, last } = setup({ selectedSpaceId: 'A-03' })
    drag(screen.getByTestId('schematic-handle-se'), 20, 30)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(rectOf(last(), 'A-03')).toEqual({ x: 260, y: 40, w: 120, h: 150 })
    drag(screen.getByTestId('schematic-handle-nw'), -10, -20)
    expect(rectOf(last(), 'A-03')).toEqual({ x: 250, y: 20, w: 130, h: 170 })
  })

  it('US-07 #3: drags snap to whole units, stop at the edge of the view, and grow the map to hold the space', () => {
    const { last } = setup()
    drag(spaceEl('A-03'), 2000.4, -500.6)
    // Clamped to the view (-60..1060, -60..660), then everything shifts down 80 so A-03 sits 20 from the top.
    expect(rectOf(last(), 'A-03')).toEqual({ x: 960, y: 20, w: 100, h: 120 })
    expect(rectOf(last(), 'A-01')).toEqual({ x: 40, y: 120, w: 100, h: 120 })
    expect(last().schematic).toEqual({ width: 1080, height: 680 })
  })

  it('zoom buttons narrow and widen the view; Fit goes back to the whole map', async () => {
    const { user } = setup()
    const svg = screen.getByRole('group', { name: 'Schematic editor' })
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(svg).toHaveAttribute('viewBox', '52 12 896 576')
    expect(screen.getByText('125%')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fit' }))
    expect(svg).toHaveAttribute('viewBox', '-60 -60 1120 720')
  })

  it('a drag on empty map pans the view', () => {
    setup()
    const svg = screen.getByRole('group', { name: 'Schematic editor' })
    drag(screen.getByTestId('schematic-area'), 100, 50)
    expect(svg).toHaveAttribute('viewBox', '-160 -110 1120 720')
  })

  it('with Draw space on, a drag on empty map adds a space there, labeled for its row', async () => {
    const { last, onSelectSpace, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Draw space' }))
    // In jsdom one pixel is one unit from the view's top-left corner (-60, -60).
    fireEvent.pointerDown(screen.getByTestId('schematic-area'), { clientX: 700, clientY: 100, button: 0 })
    fireEvent.pointerMove(window, { clientX: 750, clientY: 160 })
    expect(screen.getByTestId('schematic-drawbox')).toBeInTheDocument()
    fireEvent.pointerUp(window, { clientX: 800, clientY: 220 })
    const added = last().spaces.at(-1)!
    expect(added).toMatchObject({ label: 'A-06', type: 'STANDARD', rect: { x: 640, y: 40, w: 100, h: 120 } })
    expect(onSelectSpace).toHaveBeenLastCalledWith(added.spaceId)
    expect(screen.queryByTestId('schematic-drawbox')).toBeNull()
  })

  it('a click without movement selects and emits nothing', () => {
    const { onChange, onSelectSpace } = setup()
    fireEvent.pointerDown(spaceEl('A-01'), { clientX: 100, clientY: 100, button: 0 })
    fireEvent.pointerMove(window, { clientX: 101, clientY: 101 })
    fireEvent.pointerUp(window, { clientX: 101, clientY: 101 })
    expect(onSelectSpace).toHaveBeenLastCalledWith('A-01')
    expect(onChange).not.toHaveBeenCalled()
    expect(spaceEl('A-01')).toHaveClass('schematic-space--selected')
    expect(screen.getAllByTestId(/^schematic-handle-/)).toHaveLength(4)
  })

  it('arrow keys move the selected space by 1 unit, 10 with Shift', async () => {
    const { last, user } = setup({ selectedSpaceId: 'A-03' })
    spaceEl('A-03').focus()
    await user.keyboard('{ArrowRight}')
    expect(rectOf(last(), 'A-03')).toMatchObject({ x: 261, y: 40 })
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(rectOf(last(), 'A-03')).toMatchObject({ x: 261, y: 50 })
    await user.keyboard('{ArrowLeft}{ArrowUp}')
    expect(rectOf(last(), 'A-03')).toEqual({ x: 260, y: 49, w: 100, h: 120 })
  })

  it('Esc and a click on the empty map clear the selection', async () => {
    const { onSelectSpace, user } = setup({ selectedSpaceId: 'A-03' })
    spaceEl('A-03').focus()
    await user.keyboard('{Escape}')
    expect(onSelectSpace).toHaveBeenLastCalledWith(null)
    expect(screen.queryByRole('group', { name: 'Selected space' })).toBeNull()

    fireEvent.pointerDown(spaceEl('A-01'), { clientX: 0, clientY: 0, button: 0 })
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 })
    expect(onSelectSpace).toHaveBeenLastCalledWith('A-01')
    fireEvent.pointerDown(document.querySelector('.schematic__bg')!, { clientX: 0, clientY: 0, button: 0 })
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 })
    expect(onSelectSpace).toHaveBeenLastCalledWith(null)
  })

  it('Enter on a focused space selects it', async () => {
    const { onSelectSpace, user } = setup()
    spaceEl('A-02').focus()
    await user.keyboard('{Enter}')
    expect(onSelectSpace).toHaveBeenLastCalledWith('A-02')
    expect(within(panel()).getByRole('heading')).toHaveTextContent('Selected A-02')
  })

  it('US-07 #4: changing the type to ADA or EV shows it in the editor and emits it', async () => {
    const { last, user } = setup()
    await user.click(spaceEl('A-03'))
    const type = within(panel()).getByLabelText('Type')
    expect(type).toHaveValue('STANDARD')
    await user.selectOptions(type, 'ADA')
    expect(byId(last(), 'A-03').type).toBe('ADA')
    expect(within(spaceEl('A-03')).getByText('ADA')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'A-03, ADA' })).toBeInTheDocument()

    await user.selectOptions(type, 'EV')
    expect(byId(last(), 'A-03').type).toBe('EV')
    expect(within(spaceEl('A-03')).getByText('EV')).toBeInTheDocument()
    expect(within(spaceEl('A-03')).queryByText('ADA')).toBeNull()
  })

  it('US-07 #4: editing the label emits it; the space id never changes', async () => {
    const { last, user } = setup({ selectedSpaceId: 'A-03' })
    const label = within(panel()).getByLabelText('Label')
    await user.clear(label)
    await user.type(label, 'C-12')
    expect(byId(last(), 'A-03').label).toBe('C-12')
    expect(last().spaces.map((s) => s.spaceId)).toEqual(['A-01', 'A-02', 'A-03', 'A-04', 'A-05'])
    expect(screen.getByRole('button', { name: 'C-12, standard' })).toBeInTheDocument()
  })

  it('US-07 #5: renaming to an existing label marks both spaces red with "Label already used"', async () => {
    const draft = davidFixture({ spaces: [...davidFixture().spaces, space('B-04', 40, 200), space('B-05', 150, 200)] })
    const { user } = setup({ draft, selectedSpaceId: 'B-05' })
    expect(screen.queryAllByText('Label already used')).toHaveLength(0)
    const label = within(panel()).getByLabelText('Label')
    await user.clear(label)
    await user.type(label, 'B-04')

    for (const id of ['B-04', 'B-05']) {
      expect(spaceEl(id)).toHaveClass('schematic-space--error')
      expect(within(spaceEl(id)).getByText('Label already used')).toBeInTheDocument()
      expect(spaceEl(id)).toHaveAccessibleName('B-04, standard, label already used')
    }
    expect(spaceEl('A-01')).not.toHaveClass('schematic-space--error')
    expect(within(panel()).getByText('Label already used')).toBeInTheDocument()
    expect(label).toHaveAttribute('aria-invalid', 'true')

    await user.type(label, 'x')
    expect(screen.queryAllByText('Label already used')).toHaveLength(0)
    expect(spaceEl('B-04')).not.toHaveClass('schematic-space--error')
  })

  it('a retired space sharing a label is not a duplicate', () => {
    const draft = davidFixture({ spaces: [...davidFixture().spaces, space('new', 40, 200, { label: 'A-05' })] })
    setup({ draft })
    expect(screen.queryAllByText('Label already used')).toHaveLength(0)
  })

  it('spaces listed in validation issues are outlined in red and show the message', async () => {
    const issues: Issue[] = [{ code: 'rect_outside_schematic', message: 'A-02 is outside the map area', spaceIds: ['A-02'], viewId: null }]
    const { user } = setup({ issues })
    expect(spaceEl('A-02')).toHaveClass('schematic-space--error')
    expect(within(spaceEl('A-02')).getByText('!')).toBeInTheDocument()
    expect(spaceEl('A-01')).not.toHaveClass('schematic-space--error')
    await user.click(spaceEl('A-02'))
    expect(within(panel()).getByText('A-02 is outside the map area')).toBeInTheDocument()
  })

  it('US-07 #6: Retire greys the space and emits retired: true, keeping its outlines', async () => {
    const { last, user } = setup({ selectedSpaceId: 'A-01' })
    await user.click(within(panel()).getByRole('button', { name: 'Retire space' }))
    const next = last()
    expect(byId(next, 'A-01').retired).toBe(true)
    expect(next.viewpoints[0].outlines['A-01']).toEqual(davidFixture().viewpoints[0].outlines['A-01'])
    expect(next.viewpoints).toEqual(davidFixture().viewpoints)
    expect(spaceEl('A-01')).toHaveClass('schematic-space--retired')
    expect(within(spaceEl('A-01')).getByText('Retired')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Schematic' })).toHaveTextContent('3 spaces, 2 retired')
    // Retired spaces are not editable: no label or type fields, no handles.
    expect(within(panel()).queryByLabelText('Label')).toBeNull()
    expect(within(panel()).queryByLabelText('Type')).toBeNull()
    expect(screen.queryAllByTestId(/^schematic-handle-/)).toHaveLength(0)
  })

  it('a retired space cannot be dragged or moved, and Restore space brings it back', async () => {
    const { onChange, last, user } = setup()
    drag(spaceEl('A-05'), 50, 50)
    expect(onChange).not.toHaveBeenCalled()
    spaceEl('A-05').focus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).not.toHaveBeenCalled()
    await user.click(within(panel()).getByRole('button', { name: 'Restore space' }))
    expect(byId(last(), 'A-05').retired).toBe(false)
  })

  it('Delete is offered only for spaces that were never published', async () => {
    const { last, onSelectSpace, user } = setup({ selectedSpaceId: 'A-01' })
    // Based on v3: A-01 was in the draft when it loaded, so it can only be retired.
    expect(within(panel()).queryByRole('button', { name: 'Delete space' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '+ Space' }))
    const added = last().spaces[5]
    await user.click(within(panel()).getByRole('button', { name: 'Delete space' }))
    expect(last().spaces.map((s) => s.spaceId)).not.toContain(added.spaceId)
    expect(last().spaces).toHaveLength(5)
    expect(onSelectSpace).toHaveBeenLastCalledWith(null)
  })

  it('Delete uses the published ids when given, and removes the outlines', async () => {
    const { last, user } = setup({ selectedSpaceId: 'A-01', publishedSpaceIds: new Set(['A-02', 'A-03', 'A-04', 'A-05']) })
    await user.click(within(panel()).getByRole('button', { name: 'Delete space' }))
    expect(last().spaces.map((s: DraftSpace) => s.spaceId)).toEqual(['A-02', 'A-03', 'A-04', 'A-05'])
    expect(last().viewpoints[0].outlines).not.toHaveProperty('A-01')
    expect(last().viewpoints[0].outlineReview).not.toHaveProperty('A-01')
  })

  it('every space can be deleted on a lot that was never published', async () => {
    setup({ draft: davidFixture({ basedOnVersion: null }), selectedSpaceId: 'A-01' })
    expect(within(panel()).getByRole('button', { name: 'Delete space' })).toBeInTheDocument()
  })

  it('US-08 #6: hovering a space calls onHoverSpace, and hoveredSpaceId highlights it', async () => {
    const onHoverSpace = vi.fn()
    const props = {
      draft: davidFixture(),
      onChange: vi.fn(),
      issues: [],
      selectedSpaceId: null,
      onSelectSpace: vi.fn(),
      onHoverSpace,
    }
    const { rerender } = render(<SchematicEditor {...props} hoveredSpaceId={null} />)
    await userEvent.hover(spaceEl('A-02'))
    expect(onHoverSpace).toHaveBeenLastCalledWith('A-02')
    await userEvent.unhover(spaceEl('A-02'))
    expect(onHoverSpace).toHaveBeenLastCalledWith(null)
    expect(spaceEl('A-03')).not.toHaveClass('schematic-space--hovered')
    // A hover from the photo panel arrives as hoveredSpaceId.
    rerender(<SchematicEditor {...props} hoveredSpaceId="A-03" />)
    expect(spaceEl('A-03')).toHaveClass('schematic-space--hovered')
    expect(spaceEl('A-02')).not.toHaveClass('schematic-space--hovered')
  })

  it('US-07 #7: renders whatever draft it is given', () => {
    const props = { onChange: vi.fn(), issues: [], selectedSpaceId: null, onSelectSpace: vi.fn(), hoveredSpaceId: null, onHoverSpace: vi.fn() }
    const { rerender } = render(<SchematicEditor {...props} draft={davidFixture()} />)
    expect(screen.getAllByRole('button', { name: /^A-0\d/ })).toHaveLength(5)
    const reloaded = davidFixture({ revision: 8, schematic: { width: 800, height: 400 }, spaces: [space('Z-09', 10, 10)] })
    rerender(<SchematicEditor {...props} draft={reloaded} />)
    expect(screen.getByRole('group', { name: 'Schematic editor' })).toHaveAttribute('viewBox', '-48 -48 896 496')
    expect(screen.queryByRole('button', { name: /^A-0\d/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Z-09, standard' })).toBeInTheDocument()
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('an empty draft shows a hint and + Space starts row A', async () => {
    const { last, user } = setup({ draft: davidFixture({ basedOnVersion: null, spaces: [], viewpoints: [] }) })
    expect(screen.getByText('No spaces yet. Press + Space or + Row to start.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+ Space' }))
    expect(last().spaces).toEqual([expect.objectContaining({ label: 'A-01', rect: { x: 20, y: 20, w: 110, h: 180 } })])
  })

  it('stops listening for a drag after unmount', () => {
    const onChange = vi.fn()
    const { unmount } = render(
      <SchematicEditor
        draft={davidFixture()}
        onChange={onChange}
        issues={[]}
        selectedSpaceId={null}
        onSelectSpace={vi.fn()}
        hoveredSpaceId={null}
        onHoverSpace={vi.fn()}
      />,
    )
    fireEvent.pointerDown(spaceEl('A-01'), { clientX: 0, clientY: 0, button: 0 })
    fireEvent.pointerMove(window, { clientX: 50, clientY: 0 })
    act(() => unmount())
    fireEvent.pointerUp(window, { clientX: 50, clientY: 0 })
    expect(onChange).not.toHaveBeenCalled()
  })

  // Test Lot fits a grid of 110 x 130 cells (box 100 x 120) with row A's boxes at y 40 and column 1's at
  // x 40: column c's box starts at 40 + 110c, row B's at y 170. In jsdom a pixel is a unit from the view's
  // corner (-60, -60).
  it('without a grid, Ctrl/Cmd+D duplicates the selected space just right of it, labeled for its row', async () => {
    const { last, user } = setup({ selectedSpaceId: 'A-04' })
    spaceEl('A-04').focus()
    await user.keyboard('{Meta>}d{/Meta}')
    const copy = last().spaces.at(-1)!
    expect(copy).toMatchObject({ type: 'EV', rect: { x: 480, y: 40, w: 100, h: 120 } })
    expect(copy.label).toMatch(/^A-/)
  })

  describe('grid and snapping', () => {
    beforeEach(() => localStorage.clear())

    it('a moved space drops into the cell under it and takes its label', () => {
      const { last } = setup({ withGrid: true })
      drag(spaceEl('A-03'), 225, 130) // middle lands in row B, column 5
      expect(byId(last(), 'A-03')).toMatchObject({ label: 'B-05', rect: { x: 480, y: 170, w: 100, h: 120 } })
      expect(screen.getByText('Now B-05')).toBeInTheDocument()
    })

    it('refuses a move onto a cell that already has a space', () => {
      const { onChange } = setup({ withGrid: true })
      drag(spaceEl('A-01'), 110, 0) // onto A-02
      expect(onChange).not.toHaveBeenCalled()
      expect(screen.getByText('That cell already has A-02; nothing moved')).toBeInTheDocument()
    })

    it('takes the cell\'s label even when a space elsewhere has it; that one is renamed for its own cell', () => {
      // A misplaced B-05 sits in row B, column 9; the B-05 cell itself is empty.
      const draft = davidFixture({ spaces: [...davidFixture().spaces, space('far', 920, 170, { label: 'B-05' })] })
      const { last } = setup({ draft, withGrid: true })
      drag(spaceEl('A-03'), 220, 130)
      expect(byId(last(), 'A-03')).toMatchObject({ label: 'B-05', rect: { x: 480, y: 170 } })
      expect(byId(last(), 'far').label).toBe('B-09')
      expect(screen.getByText('Now B-05; the space that was B-05 is now B-09')).toBeInTheDocument()
    })

    it('arrow keys move one cell at a time', async () => {
      const { last, user } = setup({ withGrid: true, selectedSpaceId: 'A-03' })
      spaceEl('A-03').focus()
      await user.keyboard('{ArrowDown}')
      expect(byId(last(), 'A-03')).toMatchObject({ label: 'B-03', rect: { x: 260, y: 170 } })
    })

    it('a space moved into a row of angled stalls leans like them', async () => {
      const row = [space('B-01', 40, 170, { skewDeg: 45 }), space('B-02', 150, 170, { skewDeg: 45 }), space('B-04', 370, 170, { skewDeg: 45 })]
      const draft = davidFixture({ spaces: [...davidFixture().spaces, ...row] })
      const { last, user } = setup({ draft, withGrid: true, selectedSpaceId: 'A-03' })
      spaceEl('A-03').focus()
      await user.keyboard('{ArrowDown}')
      expect(byId(last(), 'A-03')).toMatchObject({ label: 'B-03', rect: { x: 260, y: 170 }, skewDeg: 45 })
    })

    it('Draw space across cells adds one space per free cell, named for each', async () => {
      const { last, user } = setup({ withGrid: true })
      await user.click(screen.getByRole('button', { name: 'Draw space' }))
      fireEvent.pointerDown(screen.getByTestId('schematic-area'), { clientX: 110, clientY: 290, button: 0 })
      fireEvent.pointerMove(window, { clientX: 330, clientY: 290 })
      expect(screen.getAllByTestId('schematic-drawcell')).toHaveLength(3)
      fireEvent.pointerUp(window, { clientX: 330, clientY: 290 })
      expect(last().spaces.slice(-3).map((s) => [s.label, s.rect.x, s.rect.y])).toEqual([
        ['B-01', 40, 170],
        ['B-02', 150, 170],
        ['B-03', 260, 170],
      ])
      expect(screen.getByText('Added 3 spaces, B-01 to B-03')).toBeInTheDocument()
    })

    it('with Snap to grid off, moves are free, and landing in another cell still renames', async () => {
      const { last, user } = setup({ withGrid: true })
      await user.click(screen.getByRole('checkbox', { name: 'Snap to grid' }))
      drag(spaceEl('A-03'), 225, 130)
      expect(byId(last(), 'A-03')).toMatchObject({ label: 'B-05', rect: { x: 485, y: 170 } })
      drag(spaceEl('A-03'), 5, 0) // still in B-05's cell: no rename, no snap
      expect(byId(last(), 'A-03')).toMatchObject({ label: 'B-05', rect: { x: 490, y: 170 } })
    })

    it('a resize never renames, even when the middle crosses into another cell', async () => {
      const { last, user } = setup({ withGrid: true, selectedSpaceId: 'A-03' })
      await user.click(screen.getByRole('checkbox', { name: 'Snap to grid' }))
      drag(screen.getByTestId('schematic-handle-se'), 250, 0) // middle moves 125 to the right
      expect(byId(last(), 'A-03')).toMatchObject({ label: 'A-03', rect: { x: 260, w: 350 } })
    })

    it('Ctrl/Cmd+C then Ctrl/Cmd+V pastes a copy in the next free cell, named for it, and selects it', async () => {
      const { last, user, onSelectSpace } = setup({ withGrid: true, selectedSpaceId: 'A-02' })
      spaceEl('A-02').focus()
      await user.keyboard('{Meta>}c{/Meta}')
      expect(screen.getByText('Copied A-02: Ctrl/Cmd+V pastes it in the next free cell')).toBeInTheDocument()
      await user.keyboard('{Control>}v{/Control}')
      const copy = last().spaces.at(-1)!
      expect(copy).toMatchObject({ label: 'A-05', type: 'ADA', rect: { x: 480, y: 40, w: 100, h: 120 } })
      expect(byId(last(), 'A-02').rect).toMatchObject({ x: 150, y: 40 }) // the original stays
      expect(onSelectSpace).toHaveBeenLastCalledWith(copy.spaceId)
      expect(screen.getByText('Pasted a copy of A-02 as A-05; drag it where it belongs')).toBeInTheDocument()
    })

    it('Duplicate space puts copies one after another along the row', async () => {
      const { last, user } = setup({ withGrid: true, selectedSpaceId: 'A-04' })
      await user.click(within(panel()).getByRole('button', { name: 'Duplicate space' }))
      await user.click(within(panel()).getByRole('button', { name: 'Duplicate space' }))
      expect(last().spaces.slice(-2).map((s) => [s.label, s.type, s.rect.x])).toEqual([
        ['A-05', 'EV', 480],
        ['A-06', 'EV', 590],
      ])
    })

    it('Alt/Option-drag leaves the space and drops a copy in the cell where it is let go', () => {
      const { last } = setup({ withGrid: true })
      fireEvent.pointerDown(spaceEl('A-02'), { clientX: 100, clientY: 100, button: 0, altKey: true })
      fireEvent.pointerMove(window, { clientX: 260, clientY: 165 })
      expect(screen.getByTestId('schematic-drawbox')).toBeInTheDocument() // the copy's ghost
      fireEvent.pointerUp(window, { clientX: 430, clientY: 230 })
      expect(byId(last(), 'A-02').rect).toMatchObject({ x: 150, y: 40 })
      expect(last().spaces.at(-1)).toMatchObject({ label: 'B-05', type: 'ADA', rect: { x: 480, y: 170 } })
      expect(screen.queryByTestId('schematic-drawbox')).not.toBeInTheDocument()
      expect(screen.getByText('Dropped a copy of A-02 as B-05')).toBeInTheDocument()
    })

    it('a snapped drag that ends in the same cell keeps the label', () => {
      const spaces = davidFixture().spaces.map((s) => (s.spaceId === 'A-03' ? { ...s, label: 'Q-01' } : s))
      const { last } = setup({ draft: davidFixture({ spaces }), withGrid: true })
      drag(spaceEl('A-03'), 20, 10)
      expect(byId(last(), 'A-03')).toMatchObject({ label: 'Q-01', rect: { x: 260, y: 40 } })
    })

    it('a space moved before a row\'s first number becomes 01 and the row moves up one', () => {
      const { last } = setup({ withGrid: true })
      drag(spaceEl('A-03'), -330, 0) // left of A-01, into the cell before column 1
      const labels = (ids: string[]) => ids.map((id) => byId(last(), id).label)
      // Only the spaces numbered below it move up; A-03's old hole closes.
      expect(labels(['A-03', 'A-01', 'A-02', 'A-04'])).toEqual(['A-01', 'A-02', 'A-03', 'A-04'])
      expect(byId(last(), 'A-03').rect).toMatchObject({ x: 40, y: 40 })
      expect(byId(last(), 'A-01').rect).toMatchObject({ x: 150, y: 40 })
      expect(screen.getByText('Now A-01; the rest of row A moved up one to make room')).toBeInTheDocument()
    })

    it('a blocked insert (a name in the way) moves nothing and says so', () => {
      const draft = davidFixture({ spaces: [...davidFixture().spaces, space('g', 150, 40, { label: 'Gate' })] }) // Gate in A-02's cell
      const { onChange } = setup({ draft, withGrid: true })
      drag(spaceEl('A-03'), -330, 0)
      expect(onChange).not.toHaveBeenCalled()
      expect(screen.getByText(/Row A can't move up to make room/)).toBeInTheDocument()
    })

    it('+ Space adds the next free cell in the selected row, or starts a new row below', async () => {
      const { last, user } = setup({ withGrid: true, selectedSpaceId: 'A-02' })
      await user.click(screen.getByRole('button', { name: '+ Space' }))
      // A-03 and A-04 fill the cells right of A-02 (A-05 is retired, its cell free): the first free is column 5.
      expect(last().spaces.at(-1)).toMatchObject({ label: 'A-05', rect: { x: 480, y: 40 } })
      await user.keyboard('{Escape}')
      await user.click(screen.getByRole('button', { name: '+ Space' }))
      expect(last().spaces.at(-1)).toMatchObject({ label: 'B-01', rect: { x: 40, y: 170 } })
    })

    it('Fit grid with a space selected lines the grid up with that space', async () => {
      const spaces = davidFixture().spaces.map((s) => (s.spaceId === 'A-03' ? { ...s, rect: { x: 265, y: 45, w: 90, h: 110 } } : s))
      const { last, user } = setup({ draft: davidFixture({ spaces }), withGrid: true, selectedSpaceId: 'A-03' })
      await user.click(screen.getByRole('button', { name: 'Fit grid to A-03' }))
      expect(screen.getByRole('spinbutton', { name: 'Space width' })).toHaveValue(90)
      expect(screen.getByRole('spinbutton', { name: 'Space height' })).toHaveValue(110)
      // A-03 now sits exactly in its cell, so snapping it changes nothing; A-01 aligns in place.
      await user.click(screen.getByRole('button', { name: 'Align all to grid' }))
      expect(byId(last(), 'A-03').rect).toEqual({ x: 265, y: 45, w: 90, h: 110 })
      expect(byId(last(), 'A-01')).toMatchObject({ label: 'A-01', rect: { w: 90, h: 110 } })
    })

    it('shows the grid with row letters, and can hide it', async () => {
      const { user } = setup({ withGrid: true })
      const lines = screen.getByTestId('schematic-grid')
      expect(within(lines as unknown as HTMLElement).getByText('A')).toBeInTheDocument()
      await user.click(screen.getByRole('checkbox', { name: 'Show grid' }))
      expect(screen.queryByTestId('schematic-grid')).toBeNull()
    })

    it('after Align all grows the map left, the grid moves with the spaces', async () => {
      const { last, user } = setup({ withGrid: true, selectedSpaceId: 'A-01' })
      const gap = screen.getByRole('spinbutton', { name: 'Gap across' })
      await user.clear(gap)
      await user.type(gap, '60{Enter}') // pitch 160: column 1's box now starts at x -35
      await user.click(screen.getByRole('button', { name: 'Align all to grid' }))
      expect(byId(last(), 'A-01').rect.x).toBe(20) // everything shifted right by 55
      spaceEl('A-01').focus()
      await user.keyboard('{ArrowDown}')
      expect(byId(last(), 'A-01')).toMatchObject({ label: 'B-01', rect: { x: 20 } })
    })

    it('a new space size and Align all resize every labeled space into its cell', async () => {
      const { last, user } = setup({ withGrid: true })
      const width = screen.getByRole('spinbutton', { name: 'Space width' })
      await user.clear(width)
      await user.type(width, '80{Enter}')
      await user.click(screen.getByRole('button', { name: 'Align all to grid' }))
      // Gap across stays 10, so the pitch is 90; the grid re-centres on the spaces (median of x - 90c
      // over A-01..A-04 is 70), so A-03 (column 3) starts at 70 + 180.
      expect(byId(last(), 'A-03').rect).toEqual({ x: 250, y: 40, w: 80, h: 120 })
      expect(byId(last(), 'A-01').rect).toEqual({ x: 70, y: 40, w: 80, h: 120 })
    })
  })
})


describe('straighten, north and angled stalls', () => {
  it('Straighten from photo lays the angled camera lot out in level rows on the grid', async () => {
    const { user, last } = setup({ draft: pklotFixture(), withGrid: true, photoViewId: 'V1' })
    await user.click(screen.getByRole('button', { name: 'Straighten from photo' }))
    const next = last()
    expect(new Set(next.spaces.map((s) => s.label[0]))).toEqual(new Set(['A', 'B', 'C', 'D']))
    expect(screen.getByText(/Straightened 27 spaces into 4 rows.*angled rows A 45°, B 45°, C 45°, D 45°/)).toBeInTheDocument()
    // Angled stalls are drawn leaning.
    const leaning = next.spaces.find((s) => s.skewDeg)
    expect(leaning).toBeDefined()
    expect(spaceEl(leaning!.spaceId).querySelector('polygon.schematic-space__rect')).not.toBeNull()
  })

  it('is offered only with a photo beside the map, and says what it needs', async () => {
    setup({ withGrid: true })
    expect(screen.queryByRole('button', { name: 'Straighten from photo' })).not.toBeInTheDocument()
    const few = pklotFixture()
    few.viewpoints[0].outlines = Object.fromEntries(Object.entries(few.viewpoints[0].outlines).slice(0, 3))
    const { user } = setup({ draft: few, withGrid: true, photoViewId: 'V1' })
    await user.click(screen.getByRole('button', { name: 'Straighten from photo' }))
    expect(screen.getByText(/Outline at least 6 spaces on this photo first \(3 so far\)/)).toBeInTheDocument()
  })

  it('sets north, shows the compass, and clears it', async () => {
    const { user, last } = setup()
    await user.click(screen.getByRole('button', { name: 'Orient map' }))
    const field = screen.getByRole('spinbutton', { name: /North/ })
    await user.type(field, '370{Enter}')
    expect(last().schematic.northDeg).toBe(10)
    // On the map, top right, and on the Orient button.
    expect(screen.getAllByRole('img', { name: 'North is 10° clockwise from up' }).some((c) => c.classList.contains('map-compass'))).toBe(true)
    await user.clear(field)
    await user.keyboard('{Enter}')
    expect('northDeg' in last().schematic).toBe(false)
  })

  it("sets a space's lean, and 0 makes it square again", async () => {
    const draft = davidFixture()
    const id = draft.spaces[0].spaceId
    const { user, last } = setup({ draft, selectedSpaceId: id })
    const lean = screen.getByRole('spinbutton', { name: /Lean/ })
    await user.clear(lean)
    await user.type(lean, '45{Enter}')
    expect(byId(last(), id).skewDeg).toBe(45)
    expect(spaceEl(id).querySelector('polygon')).not.toBeNull()
    await user.clear(lean)
    await user.type(lean, '0{Enter}')
    expect('skewDeg' in byId(last(), id)).toBe(false)
    expect(spaceEl(id).querySelector('polygon')).toBeNull()
  })
})


describe('orienting the map', () => {
  it('turns the map a quarter, like a photo, and the compass with it; north up turns it back', async () => {
    const draft = davidFixture()
    draft.schematic = { ...draft.schematic, northDeg: 90 }
    const { user, last } = setup({ draft })
    await user.click(screen.getByRole('button', { name: 'Orient map' }))
    await user.click(screen.getByRole('button', { name: 'Turn right a quarter' }))
    expect(last().schematic.rotationDeg).toBe(90)
    expect(last().spaces).toEqual(draft.spaces) // the layout itself is unchanged
    expect(screen.getByTestId('schematic-turn')).toHaveAttribute('transform', 'rotate(90 500 300)')
    // The whole turned map fits the view: 600 wide, 1000 tall, about the same middle.
    expect(screen.getByRole('group', { name: 'Schematic editor' })).toHaveAttribute('viewBox', '140 -260 720 1120')
    expect(screen.getAllByRole('img', { name: 'North is 180° clockwise from up' }).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'North up' }))
    expect(last().schematic.rotationDeg).toBe(270)
    expect(screen.getAllByRole('img', { name: 'North is 0° clockwise from up' }).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect('rotationDeg' in last().schematic).toBe(false)
  })

  it('turns to any angle with the slider, kept when you let go', async () => {
    const { last, onChange } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Orient map' }))
    const slider = screen.getByRole('slider', { name: 'Turn map (degrees)' })
    fireEvent.change(slider, { target: { value: '30' } })
    expect(screen.getByTestId('schematic-turn')).toHaveAttribute('transform', 'rotate(30 500 300)')
    expect(onChange).not.toHaveBeenCalled() // only shown while dragging
    fireEvent.pointerUp(slider)
    expect(last().schematic.rotationDeg).toBe(30)
  })

  it('on a turned map, a drag moves the space along the map as shown', () => {
    const draft = davidFixture()
    draft.schematic = { ...draft.schematic, rotationDeg: 90 }
    const [id, other] = [draft.spaces[0].spaceId, draft.spaces[1].spaceId]
    const gap = (d: DraftLayout) => {
      const [a, b] = [d.spaces.find((sp) => sp.spaceId === id)!.rect, d.spaces.find((sp) => sp.spaceId === other)!.rect]
      return [a.x - b.x, a.y - b.y]
    }
    const before = gap(draft)
    const { last } = setup({ draft })
    // Dragged 50 to the right on screen: on a map turned a quarter right, that is 50 up the map (the map
    // grows to hold it, moving every space alike, so it is measured against a neighbour).
    drag(spaceEl(id), 50, 0)
    const after = gap(last())
    expect(after[0] - before[0]).toBe(0)
    expect(after[1] - before[1]).toBe(-50)
  })

  it('shows viewpoint coverage indicators when a reference photo view is active', () => {
    const draft = davidFixture()
    // V1 outlines A-01, V2 outlines A-02, A-03 has no outlines
    draft.viewpoints = [
      {
        viewId: 'V1',
        name: 'View 1',
        referenceImage: null,
        outlines: { 'A-01': [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]] },
        outlineReview: {},
      },
      {
        viewId: 'V2',
        name: 'View 2',
        referenceImage: null,
        outlines: { 'A-02': [[0.3, 0.3], [0.4, 0.3], [0.4, 0.4], [0.3, 0.4]] },
        outlineReview: {},
      },
    ]

    setup({ draft, photoViewId: 'V1' })

    const dot1 = screen.getByTestId('coverage-A-01')
    expect(dot1).toHaveClass('schematic-space__coverage--in-view')

    const dot2 = screen.getByTestId('coverage-A-02')
    expect(dot2).toHaveClass('schematic-space__coverage--other-view')

    const dot3 = screen.getByTestId('coverage-A-03')
    expect(dot3).toHaveClass('schematic-space__coverage--unmapped')
  })

  it('distinguishes pending proposals from accepted outlines in viewpoint coverage indicators', () => {
    const draft = davidFixture()
    draft.viewpoints = [
      {
        viewId: 'V1',
        name: 'View 1',
        referenceImage: null,
        outlines: {
          'A-01': [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]],
          'A-02': [[0.2, 0.1], [0.3, 0.1], [0.3, 0.2], [0.2, 0.2]],
        },
        outlineReview: {
          'A-02': { source: 'proposed', status: 'pending' },
        },
      },
    ]

    setup({ draft, photoViewId: 'V1' })

    const dot1 = screen.getByTestId('coverage-A-01')
    expect(dot1).toHaveClass('schematic-space__coverage--in-view')

    const dot2 = screen.getByTestId('coverage-A-02')
    expect(dot2).toHaveClass('schematic-space__coverage--pending')
    expect(dot2).not.toHaveClass('schematic-space__coverage--in-view')
    expect(screen.getByLabelText(/A-02.*Proposed outline pending review/i)).toBeInTheDocument()
  })
})
