import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putFile } from '../lib/putFile'
import { mockFetch } from '../test/helpers'
import { rylanDraftFixture } from './fixtures/rylan'
import { ReferencePhotoPanel } from './ReferencePhotoPanel'
import type { DraftLayout, ReferencePhotoPanelProps } from './types'

vi.mock('../lib/putFile', () => ({ putFile: vi.fn() }))

describe('ReferencePhotoPanel (US-08)', () => {
  beforeEach(() => {
    vi.mocked(putFile).mockResolvedValue()
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
    const onReferenceUploaded = vi.fn<ReferencePhotoPanelProps['onReferenceUploaded']>()
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
    const fetchMock = mockFetch({
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
    // The stored photo goes to the page, so it shows even if the refetch that follows fails.
    await vi.waitFor(() => {
      expect(onReferenceUploaded).toHaveBeenCalledWith({
        lotId: 'test-lot',
        viewId: 'V3',
        referenceImage: { url: '/api/_test/objects/ref-v3.jpg', width: 1000, height: 750 },
      })
    })
    // The server reads the photo's size from the file; the panel sends only the hash.
    const complete = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/reference/complete'))
    expect(Object.keys(JSON.parse(String(complete?.[1]?.body)))).toEqual(['sha256'])
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
    const { onChange, onSave } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a03' })

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

    expect(onSave).not.toHaveBeenCalled() // a partial outline is not saved

    // Click 4 (completes outline)
    fireEvent.click(svg, { clientX: 50, clientY: 150 })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(1) // the finished outline is saved to the draft
    const updatedDraft: DraftLayout = onChange.mock.calls[0][0]
    const v1 = updatedDraft.viewpoints.find((v) => v.viewId === 'V1')!
    expect(v1.outlines['sp_a03']).toHaveLength(4)
    expect(v1.outlineReview?.['sp_a03']).toEqual({ source: 'drawn', status: 'accepted' })

    // Exact user-facing message from US-08 #2
    expect(screen.getByText('A-03 outlined in V1')).toBeInTheDocument()
  })

  // --- US-08 #3: Adjust a Polygon ------------------------------------------
  it('US-08 #3: dragging a corner handle emits updated polygon on pointer up', async () => {
    const { onChange, onSave } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a01' })

    // A-01 already has an outline in V1; corner handles are shown
    const handle0 = screen.getByTestId('corner-handle-0')
    expect(handle0).toBeInTheDocument()

    // Start drag on handle 0
    fireEvent.pointerDown(handle0, { clientX: 50, clientY: 100 })

    // Move to new position (200, 200) -> 200/500 = 0.4
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200 })
    expect(onSave).not.toHaveBeenCalled()

    // Pointer up saves to draft
    fireEvent.pointerUp(window)

    // Trailing click from mouse release must not start a new drawing or reset outline
    const svg = screen.getByRole('img', { name: /Reference for North corner/i })
    fireEvent.click(svg, { clientX: 200, clientY: 200 })

    expect(screen.queryByText(/Click the 4 corners/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('partial-clicks')).not.toBeInTheDocument()

    expect(onChange).toHaveBeenCalledTimes(1)
    // US-08 #3: "the change is saved to the draft", on pointer up, without pressing Save
    expect(onSave).toHaveBeenCalledTimes(1)
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

  it('says so when a new viewpoint could not be saved', async () => {
    const { user } = renderPanel({ viewId: 'V1', onSave: async () => null })

    await user.click(screen.getByRole('button', { name: '+ Viewpoint' }))
    await user.type(screen.getByPlaceholderText('e.g. South Corner'), 'South Gate')
    await user.click(screen.getByRole('button', { name: 'Add Viewpoint' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'South Gate (V4) is not saved yet. Save the draft to keep it.',
    )
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
    const { user, onChange, onSave } = renderPanel({ viewId: 'V1' })

    const rejectBtn = screen.getByRole('button', { name: 'Reject' })
    await user.click(rejectBtn)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(1)
    const updatedDraft: DraftLayout = onChange.mock.calls[0][0]
    const v1 = updatedDraft.viewpoints.find((v) => v.viewId === 'V1')!
    expect(v1.outlines['sp_a02']).toBeUndefined()
    expect(v1.outlineReview?.['sp_a02']).toBeUndefined()
  })

  // --- Delete outline ------------------------------------------------------
  it('allows deleting an existing outline', async () => {
    const { user, onChange, onSave } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a01' })

    const deleteBtn = screen.getByRole('button', { name: 'Delete outline' })
    await user.click(deleteBtn)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(1)
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

  // --- The Propose test hook -----------------------------------------------
  it('offers Propose (a test hook for the review flow) only in dev and test builds', () => {
    renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a01' })
    expect(screen.getByRole('button', { name: 'Propose' })).toBeInTheDocument()
  })

  it('leaves Propose out of a production build', () => {
    vi.stubEnv('DEV', false)
    try {
      renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a01' })
      expect(screen.getByRole('button', { name: 'Delete outline' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Propose' })).not.toBeInTheDocument()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // --- Reference photo loading ---------------------------------------------
  const V1_URL = '/api/_test/objects/reference/test-lot/V1/2585ffab2de3.jpg'
  const photo = () => screen.getByRole('img', { name: 'Reference for North Corner' })

  function withV1Url(url: string): DraftLayout {
    const draft = structuredClone(rylanDraftFixture)
    draft.viewpoints = draft.viewpoints.map((v) =>
      v.viewId === 'V1' && v.referenceImage ? { ...v, referenceImage: { ...v.referenceImage, url } } : v,
    )
    return draft
  }

  /** The panel showing `viewId` of `draft`, for rerendering with a re-signed or replaced photo. */
  function panelFor(draft: DraftLayout, viewId = 'V1') {
    return (
      <ReferencePhotoPanel
        lotId="test-lot"
        draft={draft}
        viewId={viewId}
        onViewChange={vi.fn()}
        onChange={vi.fn()}
        onReferenceUploaded={vi.fn()}
        issues={[]}
        selectedSpaceId={null}
        onSelectSpace={vi.fn()}
        hoveredSpaceId={null}
        onHoverSpace={vi.fn()}
      />
    )
  }

  it('a photo that fails to load shows an error and Reload photo, never a stand-in photo', async () => {
    const { user, onReferenceUploaded } = renderPanel({ viewId: 'V1' })
    expect(screen.getByText('Loading photo…')).toBeInTheDocument()
    fireEvent.error(photo())

    expect(screen.getByRole('alert')).toHaveTextContent('The reference photo did not load')
    expect(photo()).toHaveAttribute('src', V1_URL) // nothing else is shown under the outlines

    await user.click(screen.getByRole('button', { name: 'Reload photo' }))
    expect(onReferenceUploaded).toHaveBeenCalledTimes(1) // fetches fresh signed URLs
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Loading photo…')).toBeInTheDocument()
  })

  it('keeps a loaded photo when a save re-signs its URL, and loads a replaced photo', () => {
    const { rerender } = render(panelFor(withV1Url(`${V1_URL}?sig=1`)))
    const img = photo()
    fireEvent.load(img)
    expect(screen.queryByText('Loading photo…')).not.toBeInTheDocument()

    rerender(panelFor(withV1Url(`${V1_URL}?sig=2`))) // same object, new signature
    expect(photo()).toBe(img) // not remounted
    expect(img).toHaveAttribute('src', `${V1_URL}?sig=1`) // not fetched again
    expect(screen.queryByText('Loading photo…')).not.toBeInTheDocument()

    const replaced = '/api/_test/objects/reference/test-lot/V1/ffffffffffff?sig=3'
    rerender(panelFor(withV1Url(replaced)))
    expect(photo()).toHaveAttribute('src', replaced)
    expect(screen.getByText('Loading photo…')).toBeInTheDocument()
  })

  it('shows the signed URL it was given, whatever its host', () => {
    const signed = 'https://bucket.example.com/ref-v2/photo?X-Amz-Signature=abc'
    render(panelFor(withV1Url(signed)))
    expect(photo()).toHaveAttribute('src', signed)
  })

  it('takes a re-signed URL for a photo that failed to load', () => {
    const { rerender } = render(panelFor(withV1Url(`${V1_URL}?sig=expired`)))
    fireEvent.error(photo())
    rerender(panelFor(withV1Url(`${V1_URL}?sig=fresh`)))
    expect(photo()).toHaveAttribute('src', `${V1_URL}?sig=fresh`)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // --- Viewpoints and the spaces table -------------------------------------
  it('switching viewpoints shows that view’s photo and outlines', async () => {
    const { user, onViewChange, rerender } = renderPanel({ viewId: 'V1' })
    expect(photo()).toHaveAttribute('src', V1_URL)
    expect(screen.getByTestId('space-polygon-sp_a02')).toBeInTheDocument()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Viewpoint' }), 'V2')
    expect(onViewChange).toHaveBeenCalledWith('V2')
    rerender(panelFor(structuredClone(rylanDraftFixture), 'V2'))

    expect(screen.getByRole('img', { name: 'Reference for East Gate' })).toHaveAttribute(
      'src',
      '/api/_test/objects/reference/test-lot/V2/2585ffab2de3.jpg',
    )
    expect(screen.getByTestId('space-polygon-sp_a01')).toBeInTheDocument()
    expect(screen.queryByTestId('space-polygon-sp_a02')).not.toBeInTheDocument()
  })

  it('the table and summary show outlined, proposed, unmapped and retired spaces', () => {
    renderPanel({ viewId: 'V1' })
    const badge = (spaceId: string) => within(screen.getByTestId(`space-item-${spaceId}`)).getAllByRole('cell')[3]
    expect(badge('sp_a01')).toHaveTextContent('Outlined')
    expect(badge('sp_a02')).toHaveTextContent('Proposed')
    expect(badge('sp_a03')).toHaveTextContent('Not outlined')
    expect(badge('sp_a04')).toHaveTextContent('Not outlined')
    expect(badge('sp_a05')).toHaveTextContent('Retired')

    const summary = screen.getByRole('region', { name: 'Viewpoint summary' })
    expect(summary).toHaveTextContent('5 spaces total')
    expect(summary).toHaveTextContent('3 outlined in V1')
    expect(summary).toHaveTextContent('1 proposed')
    // A-03 and A-04; the retired A-05's outline does not stand in for one of them.
    expect(summary).toHaveTextContent('2 unmapped')
  })

  // --- The photo does not move while a space is outlined -------------------
  /** Everything rendered above the photo in the panel, in document order. */
  function aboveThePhoto(container: HTMLElement): string {
    const section = container.querySelector('section.ref-panel')!
    const parts: string[] = []
    for (let el: Element = container.querySelector('.photo-view')!; el !== section; el = el.parentElement!) {
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) parts.unshift(sib.outerHTML)
    }
    return parts.join('\n')
  }

  it('nothing above the photo changes while a space is outlined', () => {
    const { container } = renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a03' })
    const svg = screen.getByTestId('photo-svg')
    const before = aboveThePhoto(container)

    fireEvent.click(svg, { clientX: 50, clientY: 50 }) // the prompt changes from 0 to 1 of 4
    expect(screen.getByText(/Click the 4 corners of A-03 \(1 of 4\)/)).toBeInTheDocument()
    expect(aboveThePhoto(container)).toBe(before)

    fireEvent.click(svg, { clientX: 150, clientY: 50 })
    fireEvent.click(svg, { clientX: 150, clientY: 150 })
    fireEvent.click(svg, { clientX: 50, clientY: 150 }) // a notice appears
    expect(screen.getByText('A-03 outlined in V1')).toBeInTheDocument()
    expect(aboveThePhoto(container)).toBe(before)
  })

  it('clears the outlined notice after a few seconds', () => {
    vi.useFakeTimers()
    try {
      renderPanel({ viewId: 'V1', selectedSpaceId: 'sp_a03' })
      const svg = screen.getByTestId('photo-svg')
      for (const [x, y] of [
        [50, 50],
        [150, 50],
        [150, 150],
        [50, 150],
      ]) {
        fireEvent.click(svg, { clientX: x, clientY: y })
      }
      expect(screen.getByText('A-03 outlined in V1')).toBeInTheDocument()
      act(() => vi.advanceTimersByTime(4000))
      expect(screen.queryByText('A-03 outlined in V1')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  // --- Drawing new spaces on the photo, synced to the schematic ------------
  describe('new spaces from the photo', () => {
    // Accepted outlines for A-01..A-04 laid out like their schematic rects (x/1000, y/600), so the
    // photo maps onto the schematic; A-05 has none and is active here.
    function syncedDraft(): DraftLayout {
      const draft = structuredClone(rylanDraftFixture)
      draft.spaces[4].retired = false
      const v1 = draft.viewpoints[0]
      v1.outlines = {}
      v1.outlineReview = {}
      for (const s of draft.spaces.slice(0, 4)) {
        const { x, y, w, h } = s.rect
        v1.outlines[s.spaceId] = [
          [x / 1000, y / 600],
          [(x + w) / 1000, y / 600],
          [(x + w) / 1000, (y + h) / 600],
          [x / 1000, (y + h) / 600],
        ]
        v1.outlineReview[s.spaceId] = { source: 'drawn', status: 'accepted' }
      }
      return draft
    }

    it('dragging a box on empty photo adds a space where the photo says it is, outlined and selected', () => {
      const { onChange, onSave, onSelectSpace } = renderPanel({ draft: syncedDraft() })
      const svg = screen.getByTestId('photo-svg')
      // 500 px wide test layout: x 325..360 px is 0.65..0.72 of the photo, so 650..720 on the schematic.
      fireEvent.pointerDown(svg, { clientX: 325, clientY: 42, button: 0 })
      fireEvent.pointerMove(window, { clientX: 340, clientY: 80 })
      expect(screen.getByTestId('photo-drawbox')).toBeInTheDocument()
      fireEvent.pointerUp(svg, { clientX: 360, clientY: 192 })
      fireEvent.click(svg, { clientX: 360, clientY: 192 }) // the click after release places no corner

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onSave).toHaveBeenCalledTimes(1)
      const next: DraftLayout = onChange.mock.calls[0][0]
      const added = next.spaces.at(-1)!
      expect(added.label).toBe('A-06')
      expect(added.rect.x).toBeCloseTo(650, -1)
      expect(added.rect.y).toBeCloseTo(50, -1)
      expect(next.viewpoints[0].outlines[added.spaceId]).toEqual([
        [0.65, 0.084],
        [0.72, 0.084],
        [0.72, 0.384],
        [0.65, 0.384],
      ])
      expect(onSelectSpace).toHaveBeenLastCalledWith(added.spaceId)
      expect(screen.getByText('Added A-06 to the schematic')).toBeInTheDocument()
      expect(screen.queryByTestId('partial-clicks')).not.toBeInTheDocument()
    })

    it('with nothing selected, 4 clicks on empty photo add a new space', () => {
      const { onChange } = renderPanel({ draft: syncedDraft() })
      const svg = screen.getByTestId('photo-svg')
      fireEvent.click(svg, { clientX: 325, clientY: 42 })
      expect(screen.getByText('Click the 4 corners of the new space (1 of 4)')).toBeInTheDocument()
      fireEvent.click(svg, { clientX: 360, clientY: 42 })
      fireEvent.click(svg, { clientX: 360, clientY: 192 })
      expect(onChange).not.toHaveBeenCalled()
      fireEvent.click(svg, { clientX: 325, clientY: 192 })
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange.mock.calls[0][0].spaces).toHaveLength(6)
    })

    it('four corners that fold onto each other are refused, not saved', () => {
      const { onChange } = renderPanel({ draft: syncedDraft() })
      const svg = screen.getByTestId('photo-svg')
      // The fourth click lands on the second corner again: a repeated corner.
      for (const [x, y] of [[100, 100], [200, 100], [200, 200], [200, 100]]) fireEvent.click(svg, { clientX: x, clientY: y })
      expect(onChange).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent('Those corners do not make a four-sided shape')
      // The first three corners are kept; a good fourth adds the space and clears the message.
      fireEvent.click(svg, { clientX: 100, clientY: 200 })
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('pressing a corner handle without moving it changes nothing', () => {
      const draft = syncedDraft()
      draft.viewpoints[0].outlineReview['sp_a01'] = { source: 'proposed', status: 'accepted' }
      const { onChange, onSave } = renderPanel({ draft, selectedSpaceId: 'sp_a01' })
      fireEvent.pointerDown(screen.getByTestId('corner-handle-0'), { clientX: 25, clientY: 42 })
      fireEvent.pointerUp(window)
      expect(onChange).not.toHaveBeenCalled()
      expect(onSave).not.toHaveBeenCalled()
    })

    it('a corner dragged across the opposite edge is refused; a hand-corrected outline becomes drawn', () => {
      const draft = syncedDraft()
      draft.viewpoints[0].outlineReview['sp_a01'] = { source: 'proposed', status: 'accepted' }
      const { onChange } = renderPanel({ draft, selectedSpaceId: 'sp_a01' })
      // A-01 spans x 0.05..0.15 (25..75 px), y 50/600..230/600; corner 0 is top-left.
      fireEvent.pointerDown(screen.getByTestId('corner-handle-0'), { clientX: 25, clientY: 42 })
      fireEvent.pointerMove(window, { clientX: 125, clientY: 125 }) // past the right edge: a bowtie
      fireEvent.pointerUp(window)
      expect(onChange).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent('cross the outline over itself')

      fireEvent.pointerDown(screen.getByTestId('corner-handle-0'), { clientX: 25, clientY: 42 })
      fireEvent.pointerMove(window, { clientX: 30, clientY: 45 })
      fireEvent.pointerUp(window)
      expect(onChange.mock.calls[0][0].viewpoints[0].outlineReview['sp_a01']).toEqual({ source: 'drawn', status: 'accepted' })
    })

    it('after a box drag with no trailing click (touch), the next click still places a corner', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
      renderPanel({ draft: syncedDraft() })
      const svg = screen.getByTestId('photo-svg')
      fireEvent.pointerDown(svg, { clientX: 400, clientY: 400, button: 0 })
      fireEvent.pointerMove(window, { clientX: 401, clientY: 401 }) // under the drag threshold: a tap
      fireEvent.pointerDown(svg, { clientX: 325, clientY: 42, button: 0 })
      fireEvent.pointerMove(window, { clientX: 360, clientY: 192 })
      fireEvent.pointerUp(svg, { clientX: 360, clientY: 192 })
      now.mockReturnValue(5000) // no click came; much later the admin taps a corner
      fireEvent.click(svg, { clientX: 100, clientY: 450 })
      expect(screen.getByText(/\(1 of 4\)/)).toBeInTheDocument()
    })

    it('dragging a side handle resizes the outline, and the schematic rect follows', () => {
      const { onChange } = renderPanel({ draft: syncedDraft(), selectedSpaceId: 'sp_a01' })
      // A-01's outline spans x 0.05..0.15 (25..75 px of 500); side 1 is its right side.
      fireEvent.pointerDown(screen.getByTestId('side-handle-1'), { clientX: 75, clientY: 117, button: 0 })
      fireEvent.pointerMove(window, { clientX: 100, clientY: 130 }) // only the sideways part counts
      fireEvent.pointerUp(window)
      const next: DraftLayout = onChange.mock.calls[0][0]
      const outline = next.viewpoints[0].outlines['sp_a01']
      expect(outline.map((p) => p[0])).toEqual([0.05, 0.2, 0.2, 0.05])
      expect(outline[1][1]).toBeCloseTo(50 / 600, 3)
      const rect = next.spaces.find((s) => s.spaceId === 'sp_a01')!.rect
      expect(rect.x).toBeCloseTo(50, 0)
      expect(rect.w).toBeCloseTo(150, 0)
    })

    it('dragging the selected outline moves it, and the schematic rect moves too', () => {
      const { onChange } = renderPanel({ draft: syncedDraft(), selectedSpaceId: 'sp_a01' })
      const polygon = screen.getByTestId('space-polygon-sp_a01').querySelector('polygon')!
      fireEvent.pointerDown(polygon, { clientX: 50, clientY: 100, button: 0 })
      fireEvent.pointerMove(window, { clientX: 60, clientY: 100 })
      fireEvent.pointerUp(window)
      const next: DraftLayout = onChange.mock.calls[0][0]
      expect(next.viewpoints[0].outlines['sp_a01'].map((p) => p[0])).toEqual([0.07, 0.17, 0.17, 0.07])
      expect(next.spaces.find((s) => s.spaceId === 'sp_a01')!.rect.x).toBeCloseTo(70, 0)
    })

    it('zooms the photo in and back to fit', async () => {
      const { user } = renderPanel({ draft: syncedDraft() })
      const zoom = screen.getByRole('group', { name: 'Photo zoom' })
      await user.click(within(zoom).getByRole('button', { name: 'Zoom photo in' }))
      expect(within(zoom).getByText('150%')).toBeInTheDocument()
      expect(document.querySelector('.photo-view__stage')).toHaveStyle({ transform: 'translate(0px, 0px) scale(1.5)' })
      await user.click(within(zoom).getByRole('button', { name: 'Fit' }))
      expect(within(zoom).getByText('100%')).toBeInTheDocument()
    })

    it('handles keep a usable size on screen however large the photo is', () => {
      const draft = syncedDraft()
      draft.viewpoints[0].referenceImage = { ...draft.viewpoints[0].referenceImage!, width: 2000, height: 1125 }
      renderPanel({ draft, selectedSpaceId: 'sp_a01' })
      // 2000 photo pixels drawn 500 px wide: a 6 px handle is 24 photo pixels.
      const dot = screen.getByTestId('corner-handle-0').querySelector('circle:not(.ref-handle__hit)')!
      expect(dot.getAttribute('r')).toBe('24')
    })

    it('a click on empty photo clears a selected, outlined space instead of drawing', () => {
      const { onChange, onSelectSpace } = renderPanel({ draft: syncedDraft(), selectedSpaceId: 'sp_a01' })
      fireEvent.click(screen.getByTestId('photo-svg'), { clientX: 400, clientY: 400 })
      expect(onSelectSpace).toHaveBeenLastCalledWith(null)
      expect(onChange).not.toHaveBeenCalled()
    })

    it('a selected space with no outline shows where the schematic puts it, and can take that outline', async () => {
      const { onChange, user } = renderPanel({ draft: syncedDraft(), selectedSpaceId: 'sp_a05' })
      expect(screen.getByTestId('suggested-outline')).toBeInTheDocument()
      await user.click(screen.getByTestId('use-suggestion-btn'))
      const v1 = onChange.mock.calls[0][0].viewpoints[0]
      const outline = v1.outlines['sp_a05']
      expect(outline[0][0]).toBeCloseTo(0.53, 3) // A-05's rect starts at x 530
      expect(outline[2][1]).toBeCloseTo(230 / 600, 3)
      expect(v1.outlineReview['sp_a05']).toEqual({ source: 'proposed', status: 'accepted' })
    })

    it('no suggestion without enough outlined spaces to go by', () => {
      renderPanel({ selectedSpaceId: 'sp_a03' }) // V1 has two accepted outlines
      expect(screen.queryByTestId('suggested-outline')).not.toBeInTheDocument()
    })
  })
})
