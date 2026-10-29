import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putFile } from '../lib/putFile'
import { mockFetch } from '../test/helpers'
import { rylanDraftFixture } from './fixtures/rylan'
import { ReferencePhotoPanel } from './ReferencePhotoPanel'
import type { DraftLayout } from './types'

vi.mock('../lib/putFile', () => ({ putFile: vi.fn() }))

class MockImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 1000
  naturalHeight = 750
  set src(_val: string) {
    setTimeout(() => this.onload?.(), 0)
  }
}

describe('ReferencePhotoPanel (US-08)', () => {
  beforeEach(() => {
    vi.mocked(putFile).mockResolvedValue()
    vi.stubGlobal('Image', MockImage)
    if (!window.URL.createObjectURL) {
      window.URL.createObjectURL = () => 'blob:mock'
      window.URL.revokeObjectURL = () => {}
    }
    vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 500,
      height: 500,
      top: 0,
      left: 0,
      bottom: 500,
      right: 500,
      x: 0,
      y: 0,
      toJSON: () => {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function renderPanel(props: Partial<Parameters<typeof ReferencePhotoPanel>[0]> = {}) {
    const draft: DraftLayout = props.draft ?? structuredClone(rylanDraftFixture)
    const onChange = vi.fn<(next: DraftLayout) => void>()
    if (props.onChange) {
      onChange.mockImplementation(props.onChange)
    }
    const onViewChange = vi.fn<(viewId: string) => void>()
    if (props.onViewChange) {
      onViewChange.mockImplementation(props.onViewChange)
    }
    const onReferenceUploaded = vi.fn<() => void>()
    if (props.onReferenceUploaded) {
      onReferenceUploaded.mockImplementation(props.onReferenceUploaded)
    }
    const onSelectSpace = vi.fn<(spaceId: string | null) => void>()
    if (props.onSelectSpace) {
      onSelectSpace.mockImplementation(props.onSelectSpace)
    }
    const onHoverSpace = vi.fn<(spaceId: string | null) => void>()
    if (props.onHoverSpace) {
      onHoverSpace.mockImplementation(props.onHoverSpace)
    }
    const onSave = vi.fn<() => Promise<DraftLayout | null>>().mockResolvedValue(draft)
    if (props.onSave) {
      onSave.mockImplementation(props.onSave)
    }

    const result = render(
      <ReferencePhotoPanel
        lotId="test-lot"
        draft={draft}
        viewId={props.viewId ?? 'V1'}
        onViewChange={onViewChange}
        onChange={onChange}
        onReferenceUploaded={onReferenceUploaded}
        issues={props.issues ?? []}
        selectedSpaceId={props.selectedSpaceId ?? null}
        onSelectSpace={onSelectSpace}
        hoveredSpaceId={props.hoveredSpaceId ?? null}
        onHoverSpace={onHoverSpace}
        onSave={onSave}
      />,
    )
    return {
      ...result,
      onChange,
      onViewChange,
      onReferenceUploaded,
      onSelectSpace,
      onHoverSpace,
      onSave,
      user: userEvent.setup(),
    }
  }

  // --- US-08 #1: Upload a Reference Photo -----------------------------------
  it('US-08 #1: uploads reference photo and completes flow', async () => {
    const onReferenceUploaded = vi.fn()
    mockFetch({
      'POST /admin/lots/test-lot/views/V3/reference': {
        status: 201,
        body: { uploadUrl: '/api/_test/uploads/slot-1', expiresAt: '2099-01-01T00:00:00Z' },
      },
      'POST /admin/lots/test-lot/views/V3/reference/complete': {
        status: 200,
        body: {
          viewId: 'V3',
          referenceImage: { url: '/api/_test/objects/ref-v3.jpg', width: 1000, height: 750 },
        },
      },
    })

    const { user } = renderPanel({ viewId: 'V3', onReferenceUploaded })
    expect(screen.getByText(/Viewpoint V3 has no reference photo/)).toBeInTheDocument()

    const file = new File(['fake-jpg-content'], 'photo.jpg', { type: 'image/jpeg' })
    const input = screen.getByTestId('reference-file-input')
    await user.upload(input, file)

    await vi.waitFor(() => {
      expect(putFile).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(onReferenceUploaded).toHaveBeenCalled()
    })
  })

  it('US-08 #1: shows warning when replacing an existing reference photo', async () => {
    mockFetch({
      'POST /admin/lots/test-lot/views/V1/reference': {
        status: 201,
        body: { uploadUrl: '/api/_test/uploads/slot-replace', expiresAt: '2099-01-01T00:00:00Z' },
      },
      'POST /admin/lots/test-lot/views/V1/reference/complete': {
        status: 200,
        body: {
          viewId: 'V1',
          referenceImage: { url: '/api/_test/objects/ref-v1-new.jpg', width: 1000, height: 750 },
        },
      },
    })

    const { user } = renderPanel({ viewId: 'V1' })
    expect(screen.getByRole('button', { name: 'Replace photo' })).toBeInTheDocument()

    const file = new File(['new-photo-bytes'], 'new.jpg', { type: 'image/jpeg' })
    const input = screen.getByTestId('reference-file-input')
    await user.upload(input, file)

    expect(await screen.findByText('Check outlines: the photo changed.')).toBeInTheDocument()
  })

  it('US-08 #1: saves draft before uploading photo to newly added viewpoint', async () => {
    mockFetch({
      'POST /admin/lots/test-lot/views/V3/reference': {
        status: 201,
        body: { uploadUrl: '/api/_test/uploads/slot-1', expiresAt: '2099-01-01T00:00:00Z' },
      },
      'POST /admin/lots/test-lot/views/V3/reference/complete': {
        status: 200,
        body: {
          viewId: 'V3',
          referenceImage: { url: '/api/_test/objects/ref-v3.jpg', width: 1000, height: 750 },
        },
      },
    })

    const onSave = vi.fn().mockResolvedValue(rylanDraftFixture)
    const { user } = renderPanel({ viewId: 'V3', onSave })

    const file = new File(['new-photo-bytes'], 'new.jpg', { type: 'image/jpeg' })
    const input = screen.getByTestId('reference-file-input')
    await user.upload(input, file)

    // onSave was called and completed before upload slot was requested
    expect(onSave).toHaveBeenCalled()
  })

  it('US-08 #2: clicking "Done" in drawing tools deselects the space', async () => {
    const { onSelectSpace, user } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a01' })

    const doneBtn = screen.getByTestId('done-drawing-btn')
    expect(doneBtn).toHaveTextContent('Done')
    await user.click(doneBtn)

    expect(onSelectSpace).toHaveBeenCalledWith(null)
  })

  it('pressing Escape key deselects the selected space', async () => {
    const { onSelectSpace } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a01' })

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onSelectSpace).toHaveBeenCalledWith(null)
  })

  // --- US-08 #2: Outline a Space -------------------------------------------
  it('US-08 #2: clicking 4 corners outlines selected space and shows message', async () => {
    const { onChange } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a03' })

    // Prompt shows initial state
    expect(screen.getByText('Click the 4 corners of A-03 (0 of 4)')).toBeInTheDocument()

    const svg = screen.getByTestId('photo-svg')

    // Click 1
    fireEvent.click(svg, { clientX: 50, clientY: 50 })
    expect(screen.getByText(/Click the 4 corners of A-03 \(1 of 4\)/)).toBeInTheDocument()

    // Click 2
    fireEvent.click(svg, { clientX: 150, clientY: 50 })
    expect(screen.getByText(/Click the 4 corners of A-03 \(2 of 4\)/)).toBeInTheDocument()

    // Click 3
    fireEvent.click(svg, { clientX: 150, clientY: 150 })
    expect(screen.getByText(/Click the 4 corners of A-03 \(3 of 4\)/)).toBeInTheDocument()

    // Click 4 (completes outline)
    fireEvent.click(svg, { clientX: 50, clientY: 150 })

    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDraft: DraftLayout = onChange.mock.calls[0][0]
    const v1 = updatedDraft.viewpoints.find((v) => v.viewId === 'V1')!
    expect(v1.outlines['sp_a03']).toHaveLength(4)
    expect(v1.outlineReview?.['sp_a03']).toEqual({ source: 'drawn', status: 'accepted' })

    // Exact user-facing message from US-08 #2
    expect(screen.getByText('A-03 outlined in V1')).toBeInTheDocument()
  })

  // --- US-08 #3: Adjust a Polygon ------------------------------------------
  it('US-08 #3: dragging a corner handle emits updated polygon on pointer up', async () => {
    const { onChange } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a01' })

    // A-01 already has an outline in V1; corner handles are shown
    const handle0 = screen.getByTestId('corner-handle-0')
    expect(handle0).toBeInTheDocument()

    // Start drag on handle 0
    fireEvent.pointerDown(handle0, { clientX: 50, clientY: 100 })

    // Move to new position (200, 200) -> 200/500 = 0.4
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200 })

    // Pointer up saves to draft
    fireEvent.pointerUp(window)

    // Trailing click from mouse release must not start a new drawing or reset outline
    const svg = screen.getByRole('img', { name: /Reference for North corner/i })
    fireEvent.click(svg, { clientX: 200, clientY: 200 })

    expect(screen.queryByText(/Click the 4 corners/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('partial-clicks')).not.toBeInTheDocument()

    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDraft: DraftLayout = onChange.mock.calls[0][0]
    const v1 = updatedDraft.viewpoints.find((v) => v.viewId === 'V1')!
    expect(v1.outlines['sp_a01']).toBeDefined()
    expect(v1.outlines['sp_a01']).toContainEqual([0.4, 0.4])
  })

  // --- US-08 #4: One Space in Two Viewpoints --------------------------------
  it('US-08 #4: shows correct multi-view count for spaces across viewpoints', () => {
    renderPanel({ viewId: 'V1' })

    // sp_a01 is outlined in V1 and V2 -> "A-01: 2 views"
    const itemA01 = screen.getByTestId('space-item-sp_a01')
    expect(itemA01).toHaveTextContent('A-01: 2 views')

    // sp_a02 is outlined in V1 only -> "A-02: 1 view"
    const itemA02 = screen.getByTestId('space-item-sp_a02')
    expect(itemA02).toHaveTextContent('A-02: 1 view')

    // sp_a03 has no outline -> "A-03: 0 views"
    const itemA03 = screen.getByTestId('space-item-sp_a03')
    expect(itemA03).toHaveTextContent('A-03: 0 views')
  })

  // --- US-08 #5: Cancel an Outline Midway ----------------------------------
  it('US-08 #5: Esc key cancels partial outline without saving', () => {
    const { onChange } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a03' })

    const svg = screen.getByTestId('photo-svg')
    // Click 2 corners
    fireEvent.click(svg, { clientX: 50, clientY: 50 })
    fireEvent.click(svg, { clientX: 100, clientY: 50 })
    expect(screen.getByText(/Click the 4 corners of A-03 \(2 of 4\)/)).toBeInTheDocument()

    // Press Escape
    fireEvent.keyDown(window, { key: 'Escape' })

    // Discarded: resets to 0 of 4, onChange was never called
    expect(screen.getByText('Click the 4 corners of A-03 (0 of 4)')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  // --- US-08 #6: Linked Highlight ------------------------------------------
  it('US-08 #6: hovering polygon calls onHoverSpace, and hoveredSpaceId highlights polygon', () => {
    const onHoverSpace = vi.fn()
    const { rerender } = renderPanel({ viewId: 'V1', onHoverSpace, hoveredSpaceId: null })

    const polygonA01 = screen.getByTestId('space-polygon-sp_a01')
    fireEvent.pointerEnter(polygonA01)
    expect(onHoverSpace).toHaveBeenCalledWith('sp_a01')

    fireEvent.pointerLeave(polygonA01)
    expect(onHoverSpace).toHaveBeenCalledWith(null)

    // Re-render with hoveredSpaceId="sp_a01"
    rerender(
      <ReferencePhotoPanel
        lotId="test-lot"
        draft={structuredClone(rylanDraftFixture)}
        viewId="V1"
        onViewChange={vi.fn()}
        onChange={vi.fn()}
        onReferenceUploaded={vi.fn()}
        issues={[]}
        selectedSpaceId={null}
        onSelectSpace={vi.fn()}
        hoveredSpaceId="sp_a01"
        onHoverSpace={onHoverSpace}
      />,
    )

    const updatedPolygon = screen.getByTestId('space-polygon-sp_a01')
    expect(updatedPolygon).toHaveClass('ref-polygon--hovered')
  })

  // --- Add Viewpoint -------------------------------------------------------
  it('adds a new viewpoint and calls onChange and onViewChange', async () => {
    const { user, onChange, onViewChange } = renderPanel({ viewId: 'V1' })

    await user.click(screen.getByRole('button', { name: '+ Viewpoint' }))
    const nameInput = screen.getByPlaceholderText('e.g. South Corner')
    await user.type(nameInput, 'South Gate')
    await user.click(screen.getByRole('button', { name: 'Add Viewpoint' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const nextDraft: DraftLayout = onChange.mock.calls[0][0]
    expect(nextDraft.viewpoints).toHaveLength(4)
    expect(nextDraft.viewpoints[3]).toEqual({
      viewId: 'V4',
      name: 'South Gate',
      referenceImage: null,
      outlines: {},
      outlineReview: {},
    })
    expect(onViewChange).toHaveBeenCalledWith('V4')
  })

  // --- Forward-Compatible Proposed Outlines --------------------------------
  it('allows accepting or rejecting proposed outlines', async () => {
    const { user, onChange } = renderPanel({ viewId: 'V1' })

    // sp_a02 has status: "pending" in rylanDraftFixture
    const banner = screen.getByTestId('proposal-banner-sp_a02')
    expect(banner).toBeInTheDocument()

    // Accept proposal
    const acceptBtn = screen.getByRole('button', { name: 'Accept' })
    await user.click(acceptBtn)

    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDraft: DraftLayout = onChange.mock.calls[0][0]
    const v1 = updatedDraft.viewpoints.find((v) => v.viewId === 'V1')!
    expect(v1.outlineReview?.['sp_a02']).toEqual({ source: 'proposed', status: 'accepted' })
  })

  it('rejecting a proposed outline removes it', async () => {
    const { user, onChange } = renderPanel({ viewId: 'V1' })

    const rejectBtn = screen.getByRole('button', { name: 'Reject' })
    await user.click(rejectBtn)

    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDraft: DraftLayout = onChange.mock.calls[0][0]
    const v1 = updatedDraft.viewpoints.find((v) => v.viewId === 'V1')!
    expect(v1.outlines['sp_a02']).toBeUndefined()
    expect(v1.outlineReview?.['sp_a02']).toBeUndefined()
  })

  // --- Delete outline ------------------------------------------------------
  it('allows deleting an existing outline', async () => {
    const { user, onChange } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a01' })

    const deleteBtn = screen.getByRole('button', { name: 'Delete outline' })
    await user.click(deleteBtn)

    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDraft: DraftLayout = onChange.mock.calls[0][0]
    const v1 = updatedDraft.viewpoints.find((v) => v.viewId === 'V1')!
    expect(v1.outlines['sp_a01']).toBeUndefined()
  })

  // --- Corner Fix / Undo ---------------------------------------------------
  it('allows undoing a misclicked corner with button and Backspace', async () => {
    const { user } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a03' })
    const svg = screen.getByTestId('photo-svg')

    // Click 2 corners
    fireEvent.click(svg, { clientX: 50, clientY: 50 })
    fireEvent.click(svg, { clientX: 100, clientY: 50 })
    expect(screen.getByText(/Click the 4 corners of A-03 \(2 of 4\)/)).toBeInTheDocument()

    // Undo via button
    const undoBtn = screen.getByTestId('undo-corner-btn')
    await user.click(undoBtn)
    expect(screen.getByText(/Click the 4 corners of A-03 \(1 of 4\)/)).toBeInTheDocument()

    // Place another corner, then undo via Backspace key
    fireEvent.click(svg, { clientX: 120, clientY: 60 })
    expect(screen.getByText(/Click the 4 corners of A-03 \(2 of 4\)/)).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Backspace' })
    expect(screen.getByText(/Click the 4 corners of A-03 \(1 of 4\)/)).toBeInTheDocument()
  })

  // --- Pointer-events isolation during drawing -----------------------------
  it('prevents adjacent polygons from intercepting clicks when drawing', () => {
    const { onSelectSpace } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a03' })
    const svg = screen.getByTestId('photo-svg')

    // While outlining sp_a03, existing space sp_a01 polygon has pointer-events: none
    const polygonA01 = screen.getByTestId('space-polygon-sp_a01')
    expect(polygonA01).toHaveStyle({ pointerEvents: 'none' })

    // Clicking does not switch space to sp_a01, it adds a corner to sp_a03
    fireEvent.click(svg, { clientX: 64, clientY: 72 })
    expect(onSelectSpace).not.toHaveBeenCalledWith('sp_a01')
    expect(screen.getByText(/Click the 4 corners of A-03 \(1 of 4\)/)).toBeInTheDocument()
  })

  // --- Proposed outline prompt banner actions ------------------------------
  it('shows Accept and Reject buttons when a proposed space is selected', async () => {
    const { user, onChange } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a02' })

    expect(screen.getByTestId('proposed-prompt')).toBeInTheDocument()
    const acceptBtn = screen.getByTestId('accept-proposal-btn')
    await user.click(acceptBtn)

    expect(onChange).toHaveBeenCalledTimes(1)
    const updatedDraft: DraftLayout = onChange.mock.calls[0][0]
    const v1 = updatedDraft.viewpoints.find((v) => v.viewId === 'V1')!
    expect(v1.outlineReview?.['sp_a02']).toEqual({ source: 'proposed', status: 'accepted' })
  })
})
