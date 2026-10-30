import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { davidFixture, space } from './fixtures/david'
import { SchematicEditor } from './SchematicEditor'
import type { DraftLayout, DraftSpace, Issue } from './types'

interface Options {
  draft?: DraftLayout
  selectedSpaceId?: string | null
  issues?: Issue[]
  publishedSpaceIds?: ReadonlySet<string>
}

/** Render the editor alone, holding draft, selection and hover in state like the mapping page does. */
function setup({ draft = davidFixture(), selectedSpaceId = null, issues = [], publishedSpaceIds }: Options = {}) {
  const onChange = vi.fn<(next: DraftLayout) => void>()
  const onSelectSpace = vi.fn<(id: string | null) => void>()
  const onHoverSpace = vi.fn<(id: string | null) => void>()
  function Harness() {
    const [d, setD] = useState(draft)
    const [selected, setSelected] = useState(selectedSpaceId)
    const [hovered, setHovered] = useState<string | null>(null)
    return (
      <SchematicEditor
        draft={d}
        onChange={(next) => {
          onChange(next)
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
})
