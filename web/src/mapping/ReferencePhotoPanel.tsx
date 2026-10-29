import { useEffect, useId, useRef, useState } from 'react'
import { api, errorMessage } from '../api/client'
import { putFile } from '../lib/putFile'
import { sha256Hex } from '../lib/sha256'
import { sampleParkingPhoto } from './fixtures/samplePhoto'
import {
  getSvgPoint,
  orderClockwise,
  polygonCenter,
  polygonToSvgPoints,
} from './photo/geom'
import type {
  DraftLayout,
  DraftViewpoint,
  Outline,
  Point,
  ReferenceCompleteResponse,
  ReferencePhotoPanelProps,
  ReferenceUploadSlot,
} from './types'

export function resolveImageUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (url.includes('example.com/ref-v1') || url.includes('example.com/ref-v2')) {
    url = '/api/_test/objects/reference/test-lot/V1/2585ffab2de3.jpg'
  }
  if (url.startsWith('/api/')) {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')
    return `${base}${url}`
  }
  return url
}

export function ReferencePhotoPanel({
  lotId,
  draft,
  viewId,
  onViewChange,
  onChange,
  onReferenceUploaded,
  issues,
  selectedSpaceId,
  onSelectSpace,
  hoveredSpaceId,
  onHoverSpace,
}: ReferencePhotoPanelProps) {
  const currentViewId = viewId ?? draft.viewpoints[0]?.viewId ?? null
  const currentViewpoint = draft.viewpoints.find((v) => v.viewId === currentViewId) ?? null

  const fileInputId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const [isAddingViewpoint, setIsAddingViewpoint] = useState(false)
  const [newViewpointName, setNewViewpointName] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [replaceWarning, setReplaceWarning] = useState<string | null>(null)
  const [statusNotice, setStatusNotice] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState(false)
  const [loadedDimensions, setLoadedDimensions] = useState<{ width: number; height: number } | null>(null)

  // Explicit drawing mode state: true when user is placing corners
  const [isDrawing, setIsDrawing] = useState(false)
  // Partial clicks during corner placement: [p0, p1, p2]
  const [clicks, setClicks] = useState<Point[]>([])

  // Dragging a corner handle
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [dragCorners, setDragCorners] = useState<Outline | null>(null)
  const draggingIdxRef = useRef<number | null>(null)
  const dragCornersRef = useRef<Outline | null>(null)
  const justDraggedRef = useRef(false)

  const selectedSpace = draft.spaces.find((s) => s.spaceId === selectedSpaceId) ?? null
  const selectedOutline =
    (currentViewpoint && selectedSpaceId && currentViewpoint.outlines[selectedSpaceId]) || null
  const selectedReview =
    (currentViewpoint && selectedSpaceId && currentViewpoint.outlineReview?.[selectedSpaceId]) || null
  const isSelectedProposedPending = selectedReview?.status === 'pending'

  const svgWidth = loadedDimensions?.width || currentViewpoint?.referenceImage?.width || 1000
  const svgHeight = loadedDimensions?.height || currentViewpoint?.referenceImage?.height || 750

  // When selected space or viewpoint changes, reset clicks and set drawing mode accordingly
  useEffect(() => {
    setClicks([])
    if (selectedSpace && !selectedSpace.retired && !selectedOutline) {
      setIsDrawing(true)
    } else {
      setIsDrawing(false)
    }
  }, [selectedSpaceId, currentViewId, selectedOutline === null])

  useEffect(() => {
    setPhotoError(false)
    setLoadedDimensions(null)
  }, [currentViewId, currentViewpoint?.referenceImage?.url])

  // Keyboard shortcuts:
  // - Esc: cancel clicks or exit drawing mode
  // - Backspace / Delete / Ctrl+Z: undo last placed point (solves misclicking!)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (clicks.length > 0) {
        if (e.key === 'Escape') {
          setClicks([])
          if (selectedOutline) setIsDrawing(false)
        } else if (
          e.key === 'Backspace' ||
          e.key === 'Delete' ||
          ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')
        ) {
          e.preventDefault()
          setClicks((prev) => prev.slice(0, -1))
        }
      } else if (e.key === 'Escape' && isDrawing) {
        setIsDrawing(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [clicks.length, isDrawing, selectedOutline])

  // Global pointer listeners for dragging corner handles
  useEffect(() => {
    if (draggingIdx === null) return

    const handlePointerMove = (e: PointerEvent) => {
      if (draggingIdxRef.current === null || !dragCornersRef.current || !svgRef.current) return
      justDraggedRef.current = true
      const point = getSvgPoint(svgRef.current, e.clientX, e.clientY, svgWidth, svgHeight)
      const updated = [...dragCornersRef.current]
      updated[draggingIdxRef.current] = point
      dragCornersRef.current = updated
      setDragCorners(updated)
    }

    const handlePointerUp = () => {
      const idx = draggingIdxRef.current
      const finalCorners = dragCornersRef.current
      if (idx !== null && finalCorners && currentViewpoint && selectedSpaceId) {
        // Keep corner handle indices stable without reordering
        const nextOutlines = { ...currentViewpoint.outlines, [selectedSpaceId]: finalCorners }
        const nextVps = draft.viewpoints.map((v) =>
          v.viewId === currentViewpoint.viewId ? { ...v, outlines: nextOutlines } : v,
        )
        onChange({ ...draft, viewpoints: nextVps })
      }
      draggingIdxRef.current = null
      dragCornersRef.current = null
      setDraggingIdx(null)
      setDragCorners(null)
      if (justDraggedRef.current) {
        setTimeout(() => {
          justDraggedRef.current = false
        }, 150)
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [draggingIdx, currentViewpoint, selectedSpaceId, draft, onChange, svgWidth, svgHeight])

  const handleAddViewpoint = (e: React.FormEvent) => {
    e.preventDefault()
    const name = newViewpointName.trim()
    if (!name) return

    const existingNums = draft.viewpoints
      .map((v) => {
        const m = v.viewId.match(/^V(\d+)$/)
        return m ? parseInt(m[1], 10) : 0
      })
      .filter((n) => !isNaN(n))
    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : draft.viewpoints.length + 1
    const nextViewId = `V${nextNum}`

    const newVp: DraftViewpoint = {
      viewId: nextViewId,
      name,
      referenceImage: null,
      outlines: {},
      outlineReview: {},
    }

    const nextDraft: DraftLayout = {
      ...draft,
      viewpoints: [...draft.viewpoints, newVp],
    }

    setNewViewpointName('')
    setIsAddingViewpoint(false)
    onChange(nextDraft)
    onViewChange(nextViewId)
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !currentViewpoint) return

    setErrorMsg(null)
    if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
      setErrorMsg('Photos must be JPEG or PNG')
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      setErrorMsg('Photos must be 15 MB or smaller')
      return
    }

    const hadPreviousImage = Boolean(currentViewpoint.referenceImage)
    setIsUploading(true)
    setUploadProgress(0)

    try {
      const sha256 = await sha256Hex(file)

      // 1. Reserve slot
      const slot = await api.post<ReferenceUploadSlot>(
        `/admin/lots/${lotId}/views/${currentViewpoint.viewId}/reference`,
        { contentType: file.type, sizeBytes: file.size, sha256 },
      )

      // 2. PUT file with progress
      await putFile(slot.uploadUrl, file, (fraction) => setUploadProgress(fraction))

      // 3. Read image dimensions
      const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image()
        const url = URL.createObjectURL(file)
        img.onload = () => {
          URL.revokeObjectURL(url)
          resolve({ width: img.naturalWidth || 1000, height: img.naturalHeight || 750 })
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          reject(new Error('Failed to read image dimensions'))
        }
        img.src = url
      })

      // 4. Complete upload
      const res = await api.post<ReferenceCompleteResponse>(
        `/admin/lots/${lotId}/views/${currentViewpoint.viewId}/reference/complete`,
        { sha256, width: dims.width, height: dims.height },
      )

      if (hadPreviousImage) {
        setReplaceWarning('Check outlines: the photo changed.')
      }

      setPhotoError(false)
      const nextVps = draft.viewpoints.map((v) =>
        v.viewId === currentViewpoint.viewId
          ? { ...v, referenceImage: res.referenceImage }
          : v,
      )
      onChange({ ...draft, viewpoints: nextVps })

      onReferenceUploaded()
    } catch (err) {
      setErrorMsg(errorMessage(err))
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    if (!selectedSpace || selectedSpace.retired || !currentViewpoint) return
    if (!svgRef.current) return

    // If an outline already exists and the user is NOT in drawing/redraw mode, don't start placing points on casual click
    if (selectedOutline && !isDrawing && clicks.length === 0) return

    const point = getSvgPoint(svgRef.current, e.clientX, e.clientY, svgWidth, svgHeight)

    const nextClicks = [...clicks, point]
    if (nextClicks.length < 4) {
      setClicks(nextClicks)
      setIsDrawing(true)
    } else {
      const ordered = orderClockwise(nextClicks)
      const nextOutlines = {
        ...currentViewpoint.outlines,
        [selectedSpace.spaceId]: ordered,
      }
      const nextReview = {
        ...currentViewpoint.outlineReview,
        [selectedSpace.spaceId]: { source: 'drawn' as const, status: 'accepted' as const },
      }
      const nextVps = draft.viewpoints.map((v) =>
        v.viewId === currentViewpoint.viewId
          ? { ...v, outlines: nextOutlines, outlineReview: nextReview }
          : v,
      )

      setClicks([])
      setIsDrawing(false)
      setStatusNotice(`${selectedSpace.label} outlined in ${currentViewpoint.viewId}`)
      onChange({ ...draft, viewpoints: nextVps })
    }
  }

  const handleUndoPoint = () => {
    setClicks((prev) => prev.slice(0, -1))
  }

  const handleDeleteOutline = (spaceId: string) => {
    if (!currentViewpoint) return
    const { [spaceId]: _, ...remOutlines } = currentViewpoint.outlines
    const { [spaceId]: __, ...remReview } = currentViewpoint.outlineReview ?? {}
    const nextVps = draft.viewpoints.map((v) =>
      v.viewId === currentViewpoint.viewId
        ? { ...v, outlines: remOutlines, outlineReview: remReview }
        : v,
    )
    onChange({ ...draft, viewpoints: nextVps })
    const sp = draft.spaces.find((s) => s.spaceId === spaceId)
    setStatusNotice(`Removed outline for ${sp?.label ?? spaceId}`)
  }

  const handleAcceptProposal = (spaceId: string) => {
    if (!currentViewpoint) return
    const nextReview = {
      ...currentViewpoint.outlineReview,
      [spaceId]: { source: 'proposed' as const, status: 'accepted' as const },
    }
    const nextVps = draft.viewpoints.map((v) =>
      v.viewId === currentViewpoint.viewId ? { ...v, outlineReview: nextReview } : v,
    )
    onChange({ ...draft, viewpoints: nextVps })
    const sp = draft.spaces.find((s) => s.spaceId === spaceId)
    setStatusNotice(`Accepted proposed outline for ${sp?.label ?? spaceId}`)
  }

  const handleRejectProposal = (spaceId: string) => {
    handleDeleteOutline(spaceId)
  }

  const handleProposeOutline = (spaceId: string) => {
    if (!currentViewpoint) return
    const nextReview = {
      ...currentViewpoint.outlineReview,
      [spaceId]: { source: 'proposed' as const, status: 'pending' as const },
    }
    const nextVps = draft.viewpoints.map((v) =>
      v.viewId === currentViewpoint.viewId ? { ...v, outlineReview: nextReview } : v,
    )
    onChange({ ...draft, viewpoints: nextVps })
    const sp = draft.spaces.find((s) => s.spaceId === spaceId)
    setStatusNotice(`Marked outline for ${sp?.label ?? spaceId} as proposed for review`)
  }

  const handleAcceptAllProposals = () => {
    if (!currentViewpoint) return
    const nextReview = { ...currentViewpoint.outlineReview }
    let count = 0
    for (const [sId, r] of Object.entries(nextReview)) {
      if (r.status === 'pending') {
        nextReview[sId] = { source: 'proposed', status: 'accepted' }
        count++
      }
    }
    if (count === 0) return
    const nextVps = draft.viewpoints.map((v) =>
      v.viewId === currentViewpoint.viewId ? { ...v, outlineReview: nextReview } : v,
    )
    onChange({ ...draft, viewpoints: nextVps })
    setStatusNotice(`Accepted ${count} proposed outline${count === 1 ? '' : 's'} in ${currentViewpoint.viewId}`)
  }

  const outlinedCount = Object.keys(currentViewpoint?.outlines ?? {}).length
  const proposedCount = Object.values(currentViewpoint?.outlineReview ?? {}).filter(
    (r) => r.status === 'pending',
  ).length
  const activeSpaces = draft.spaces.filter((s) => !s.retired)
  const missingCount = Math.max(0, activeSpaces.length - outlinedCount)

  // Find next unmapped space for streamlined sequence progression
  const nextUnmappedSpace =
    activeSpaces.find((s) => s.spaceId !== selectedSpaceId && !currentViewpoint?.outlines[s.spaceId]) ?? null

  // When user is actively placing points or in drawing mode, existing polygons MUST NOT intercept clicks!
  const isActivelyDrawing = isDrawing || clicks.length > 0

  return (
    <section className="mapping-panel ref-panel" aria-label="Reference photo">
      {/* Top Toolbar matching project design */}
      <div className="ref-panel__head">
        <h2>Reference photo</h2>
        <div className="ref-panel__controls">
          <label htmlFor="view-select" className="sr-only">
            Viewpoint
          </label>
          <select
            id="view-select"
            className="ref-select"
            value={currentViewId ?? ''}
            onChange={(e) => onViewChange(e.target.value)}
            disabled={draft.viewpoints.length === 0}
          >
            {draft.viewpoints.map((v) => (
              <option key={v.viewId} value={v.viewId}>
                {v.viewId} ({v.name})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={() => setIsAddingViewpoint(true)}
          >
            + Viewpoint
          </button>
          <span className="sr-only">
            {draft.viewpoints.map((v) => `${v.viewId} ${v.name}`).join(', ')}
          </span>

          {currentViewpoint && (
            <>
              <input
                id={fileInputId}
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png"
                className="sr-only"
                onChange={handleFileChange}
                data-testid="reference-file-input"
              />
              {currentViewpoint.referenceImage ? (
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                >
                  Replace photo
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--primary button--sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                >
                  Upload reference photo
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* + Viewpoint Modal */}
      {isAddingViewpoint && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-add-vp-title">
          <div className="modal">
            <h2 id="modal-add-vp-title">Add Viewpoint</h2>
            <form className="form" onSubmit={handleAddViewpoint}>
              <label>
                Viewpoint Name
                <input
                  type="text"
                  value={newViewpointName}
                  placeholder="e.g. South Corner"
                  onChange={(e) => setNewViewpointName(e.target.value)}
                  autoFocus
                  required
                />
              </label>
              <div className="modal__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => {
                    setIsAddingViewpoint(false)
                    setNewViewpointName('')
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={!newViewpointName.trim()}
                >
                  Add Viewpoint
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Notices and warnings */}
      {errorMsg && (
        <p className="notice notice--error" role="alert">
          {errorMsg}
        </p>
      )}
      {replaceWarning && (
        <p className="notice notice--warn" role="status">
          {replaceWarning}
        </p>
      )}
      {statusNotice && (
        <p className="notice notice--ok" role="status">
          {statusNotice}
        </p>
      )}

      {isUploading && (
        <div className="notice" role="status">
          <p className="hint">
            Uploading reference photo… {Math.round(uploadProgress * 100)}%
          </p>
          <progress className="progress" value={uploadProgress} max={1} />
        </div>
      )}

      {!currentViewpoint && (
        <p className="notice" role="status">
          <span>No viewpoints yet</span>. Add a viewpoint to get started.
        </p>
      )}

      {currentViewpoint && !currentViewpoint.referenceImage && !isUploading && (
        <div className="notice notice--warn ref-no-photo" role="status">
          <p>Viewpoint {currentViewpoint.viewId} has no reference photo.</p>
          <button
            type="button"
            className="button button--primary"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload reference photo
          </button>
        </div>
      )}

      {currentViewpoint && currentViewpoint.referenceImage && (
        <div className="ref-panel__body">
          {/* Outlining prompt / actions banner with sequence progression and undo/fix controls */}
          {selectedSpace && !selectedSpace.retired && (
            <>
              {/* State A: In progress clicking 4 corners */}
              {clicks.length > 0 && (
                <div className="notice ref-prompt" data-testid="outline-prompt" role="status">
                  <div className="ref-prompt__msg">
                    <span>Click the 4 corners of {selectedSpace.label} ({clicks.length} of 4)</span>
                    <span className="ref-prompt__hint">
                      · Press <strong>Backspace</strong> to undo · <strong>Esc</strong> to cancel
                    </span>
                  </div>
                  <div className="ref-prompt__actions">
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={handleUndoPoint}
                      title="Undo last placed corner (Backspace)"
                      data-testid="undo-corner-btn"
                    >
                      ↶ Undo point
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => {
                        setClicks([])
                        if (selectedOutline) setIsDrawing(false)
                      }}
                      title="Cancel outlining (Esc)"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* State B: In drawing/redraw mode, waiting for 1st click */}
              {clicks.length === 0 && isDrawing && (
                <div className="notice ref-prompt" data-testid="outline-prompt" role="status">
                  <div className="ref-prompt__msg">
                    <span>Click the 4 corners of {selectedSpace.label} (0 of 4)</span>
                    {selectedOutline && (
                      <span className="ref-prompt__hint">
                        · Redrawing outline · Existing outline will be replaced
                      </span>
                    )}
                  </div>
                  <div className="ref-prompt__actions">
                    {selectedOutline && (
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        onClick={() => setIsDrawing(false)}
                      >
                        Cancel redraw
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* State C: Space has a proposed outline pending review */}
              {clicks.length === 0 && !isDrawing && isSelectedProposedPending && selectedOutline && (
                <div className="notice notice--warn ref-prompt" data-testid="proposed-prompt" role="status">
                  <div className="ref-prompt__msg">
                    Proposed outline for <strong>{selectedSpace.label}</strong> in {currentViewpoint.viewId}{' '}
                    <span className="ref-prompt__hint">(Pending review)</span>
                  </div>
                  <div className="ref-prompt__actions">
                    <button
                      type="button"
                      className="button button--primary button--sm"
                      onClick={() => handleAcceptProposal(selectedSpace.spaceId)}
                      data-testid="accept-proposal-btn"
                    >
                      ✓ Accept proposal
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => handleRejectProposal(selectedSpace.spaceId)}
                      data-testid="reject-proposal-btn"
                    >
                      ✕ Reject
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => {
                        setIsDrawing(true)
                        setClicks([])
                      }}
                    >
                      Redraw
                    </button>
                  </div>
                </div>
              )}

              {/* State D: Space has an accepted outline */}
              {clicks.length === 0 && !isDrawing && !isSelectedProposedPending && selectedOutline && (
                <div className="notice notice--ok ref-prompt" data-testid="outline-prompt" role="status">
                  <div className="ref-prompt__msg">
                    <strong>{selectedSpace.label}</strong> outlined in {currentViewpoint.viewId}
                  </div>
                  <div className="ref-prompt__actions">
                    {nextUnmappedSpace && (
                      <button
                        type="button"
                        className="button button--primary button--sm"
                        onClick={() => onSelectSpace(nextUnmappedSpace.spaceId)}
                        title={`Outline next space: ${nextUnmappedSpace.label}`}
                      >
                        Next space: {nextUnmappedSpace.label} →
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => {
                        setIsDrawing(true)
                        setClicks([])
                      }}
                      title="Click 4 new points on the photo to redraw"
                    >
                      Redraw
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => handleProposeOutline(selectedSpace.spaceId)}
                      title="Mark outline as proposed for testing review workflow"
                    >
                      Propose
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => handleDeleteOutline(selectedSpace.spaceId)}
                    >
                      Delete outline
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {!selectedSpace && (
            <div className="notice ref-prompt" role="status">
              <span>Select a space from the table or photo below to outline it.</span>
              {nextUnmappedSpace && (
                <button
                  type="button"
                  className="button button--primary button--sm"
                  onClick={() => onSelectSpace(nextUnmappedSpace.spaceId)}
                >
                  Outline {nextUnmappedSpace.label} →
                </button>
              )}
            </div>
          )}

          {/* Photo viewer with SVG overlay */}
          <div className="photo-view">
            <img
              src={
                photoError
                  ? sampleParkingPhoto
                  : resolveImageUrl(currentViewpoint.referenceImage.url)
              }
              alt={`Reference for ${currentViewpoint.name}`}
              className="photo-view__img"
              onLoad={(e) => {
                if (e.currentTarget.naturalWidth > 0 && e.currentTarget.naturalHeight > 0) {
                  setLoadedDimensions({
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                  })
                }
              }}
              onError={() => setPhotoError(true)}
            />
            <svg
              ref={svgRef}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              preserveAspectRatio="none"
              className={`photo-view__overlay ${selectedSpace && !selectedSpace.retired && isActivelyDrawing ? 'photo-view__overlay--drawing' : ''}`}
              onClick={handleSvgClick}
              data-testid="photo-svg"
            >
              {/* Existing space polygons */}
              {Object.entries(currentViewpoint.outlines).map(([sId, outline]) => {
                const space = draft.spaces.find((s) => s.spaceId === sId)
                const isSelected = selectedSpaceId === sId
                const isHovered = hoveredSpaceId === sId
                const isRetired = space?.retired === true
                const review = currentViewpoint.outlineReview?.[sId]
                const isProposedPending = review?.status === 'pending'
                const hasIssue = issues.some(
                  (iss) =>
                    iss.spaceIds.includes(sId) &&
                    (iss.viewId === null || iss.viewId === currentViewpoint.viewId),
                )

                // If currently clicking a redraw for this space, hide the old polygon so the new clicks are clear
                if (isSelected && clicks.length > 0) {
                  return null
                }

                const activePoints = isSelected && dragCorners ? dragCorners : outline
                const ptsStr = polygonToSvgPoints(activePoints, svgWidth, svgHeight)
                const [cx, cy] = polygonCenter(activePoints, svgWidth, svgHeight)

                let stroke = 'var(--photo-free)'
                let fill = 'rgba(34, 197, 94, 0.22)'
                let strokeWidth = 2.5
                let strokeDasharray = 'none'

                if (hasIssue) {
                  stroke = 'var(--nearly-full)'
                  fill = 'rgba(180, 35, 24, 0.3)'
                  strokeWidth = 3
                } else if (isHovered) {
                  stroke = 'var(--photo-car)'
                  fill = 'rgba(56, 189, 248, 0.3)'
                  strokeWidth = 3.5
                } else if (isSelected) {
                  stroke = 'var(--accent)'
                  fill = 'rgba(31, 95, 191, 0.28)'
                  strokeWidth = 3.5
                } else if (isProposedPending) {
                  stroke = 'var(--filling)'
                  fill = 'rgba(168, 98, 0, 0.2)'
                  strokeDasharray = '6 4'
                } else if (isRetired) {
                  stroke = 'var(--no-data)'
                  fill = 'rgba(154, 163, 174, 0.15)'
                  strokeDasharray = '4 4'
                  strokeWidth = 1.75
                }

                return (
                  <g
                    key={sId}
                    data-testid={`space-polygon-${sId}`}
                    className={`ref-space-polygon ${isHovered ? 'ref-polygon--hovered' : ''} ${isActivelyDrawing ? 'ref-space-polygon--inert' : ''}`}
                    style={{ pointerEvents: isActivelyDrawing ? 'none' : 'auto' }}
                    onPointerEnter={() => !isActivelyDrawing && onHoverSpace(sId)}
                    onPointerLeave={() => !isActivelyDrawing && onHoverSpace(null)}
                    onClick={(e) => {
                      if (isActivelyDrawing) return
                      e.stopPropagation()
                      onSelectSpace(sId)
                    }}
                  >
                    <polygon
                      points={ptsStr}
                      stroke={stroke}
                      fill={fill}
                      strokeWidth={strokeWidth}
                      strokeDasharray={strokeDasharray}
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x={cx}
                      y={cy}
                      className="photo-label"
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={Math.max(12, svgWidth * 0.018)}
                    >
                      {space?.label ?? sId}
                    </text>
                    {isProposedPending && (
                      <g className="ref-proposal-chip" transform={`translate(${cx}, ${cy + 20})`}>
                        <rect
                          x={-45}
                          y={-10}
                          width={90}
                          height={20}
                          rx={10}
                          fill="var(--surface)"
                          stroke="var(--filling)"
                          strokeWidth={1.5}
                        />
                        <text
                          x={0}
                          y={4}
                          textAnchor="middle"
                          fontSize={10}
                          fontWeight={600}
                          fill="var(--filling)"
                        >
                          Proposed
                        </text>
                      </g>
                    )}
                  </g>
                )
              })}

              {/* Corner handles for selected space (when not clicking new points) */}
              {selectedSpaceId && selectedOutline && clicks.length === 0 && !isDrawing && (
                <g className="ref-handles" data-testid="selected-corner-handles">
                  {(dragCorners ?? selectedOutline).map((corner, idx) => (
                    <circle
                      key={idx}
                      data-testid={`corner-handle-${idx}`}
                      className="ref-handle"
                      cx={corner[0] * svgWidth}
                      cy={corner[1] * svgHeight}
                      r={7}
                      fill="#ffffff"
                      stroke="var(--accent)"
                      strokeWidth={2.5}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        draggingIdxRef.current = idx
                        const initial = [...(dragCornersRef.current ?? dragCorners ?? selectedOutline)]
                        dragCornersRef.current = initial
                        setDraggingIdx(idx)
                        setDragCorners(initial)
                        justDraggedRef.current = false
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                      }}
                    />
                  ))}
                </g>
              )}

              {/* Partial clicks during outline creation with sequence numbering badges */}
              {clicks.length > 0 && (
                <g className="ref-clicks" data-testid="partial-clicks">
                  <polyline
                    points={clicks.map((p) => `${p[0] * svgWidth},${p[1] * svgHeight}`).join(' ')}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={2.5}
                    strokeDasharray="4 4"
                  />
                  {clicks.map((pt, i) => (
                    <g key={i}>
                      <circle
                        cx={pt[0] * svgWidth}
                        cy={pt[1] * svgHeight}
                        r={11}
                        fill="var(--accent)"
                        stroke="#ffffff"
                        strokeWidth={2}
                      />
                      <text
                        x={pt[0] * svgWidth}
                        y={pt[1] * svgHeight}
                        fill="#ffffff"
                        fontSize={11}
                        fontWeight="bold"
                        textAnchor="middle"
                        dominantBaseline="central"
                      >
                        {i + 1}
                      </text>
                    </g>
                  ))}
                </g>
              )}
            </svg>
          </div>

          {/* Counts summary matching SnapshotPhotoPage and LotMapPage */}
          <section className="summary" aria-label="Viewpoint summary">
            <ul className="summary__counts">
              <li>
                <strong>{draft.spaces.length}</strong> {draft.spaces.length === 1 ? 'space' : 'spaces'} total
              </li>
              <li>
                <span className="ref-dot ref-dot--outlined" aria-hidden="true" />
                <strong>{outlinedCount}</strong> outlined in {currentViewpoint.viewId}
              </li>
              {proposedCount > 0 && (
                <li>
                  <span className="ref-dot ref-dot--proposed" aria-hidden="true" />
                  <strong>{proposedCount}</strong> proposed
                  <button
                    type="button"
                    className="button button--ghost button--sm"
                    onClick={handleAcceptAllProposals}
                    data-testid="accept-all-proposals-btn"
                  >
                    Accept all
                  </button>
                </li>
              )}
              {missingCount > 0 && (
                <li>
                  <span className="ref-dot ref-dot--missing" aria-hidden="true" />
                  <strong>{missingCount}</strong> unmapped
                </li>
              )}
            </ul>
          </section>

          {/* Legend matching SnapshotPhotoPage and LotMapPage */}
          <section className="legend" aria-label="Legend">
            <h2>Legend</h2>
            <ul>
              <li>
                <span className="legend-swatch ref-swatch ref-swatch--selected" aria-hidden="true" />
                Selected
              </li>
              <li>
                <span className="legend-swatch ref-swatch ref-swatch--outlined" aria-hidden="true" />
                Outlined
              </li>
              <li>
                <span className="legend-swatch ref-swatch ref-swatch--proposed" aria-hidden="true" />
                Proposed
              </li>
              <li>
                <span className="legend-swatch ref-swatch ref-swatch--retired" aria-hidden="true" />
                Retired
              </li>
            </ul>
            <p className="hint">
              Select a space from the table or photo to outline it. Press <strong>Backspace</strong> to undo a point. Drag handles to fine-tune.
            </p>
          </section>

          {/* Pending proposals banner */}
          {Object.entries(currentViewpoint.outlineReview ?? {})
            .filter(([_, rev]) => rev.status === 'pending')
            .map(([sId]) => {
              const sp = draft.spaces.find((s) => s.spaceId === sId)
              return (
                <div
                  key={sId}
                  className="notice notice--warn ref-proposal-banner"
                  data-testid={`proposal-banner-${sId}`}
                  role="status"
                >
                  <span>
                    Proposed outline for <strong>{sp?.label ?? sId}</strong>
                  </span>
                  <div className="ref-proposal-banner__actions">
                    <button
                      type="button"
                      className="button button--primary button--sm"
                      onClick={() => handleAcceptProposal(sId)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => handleRejectProposal(sId)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )
            })}

          {/* Spaces Table matching project tables */}
          <section className="ref-spaces" aria-label="Spaces">
            <div className="ref-spaces__head">
              <h2>Spaces</h2>
              <span className="hint">Click a space row or click on the photo</span>
            </div>
            <div className="ref-spaces__wrap">
              <table className="ref-spaces__table">
                <thead>
                  <tr>
                    <th scope="col">Space</th>
                    <th scope="col">Type</th>
                    <th scope="col">Views</th>
                    <th scope="col">In this view</th>
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {draft.spaces.map((space) => {
                    const count = draft.viewpoints.filter((v) => v.outlines[space.spaceId]).length
                    const isSelected = selectedSpaceId === space.spaceId
                    const isHovered = hoveredSpaceId === space.spaceId
                    const outlinedInThisView = Boolean(currentViewpoint.outlines[space.spaceId])
                    const review = currentViewpoint.outlineReview?.[space.spaceId]
                    const isProposed = review?.status === 'pending'

                    return (
                      <tr
                        key={space.spaceId}
                        data-testid={`space-item-${space.spaceId}`}
                        className={`${isSelected ? 'is-selected' : ''} ${isHovered ? 'is-hovered' : ''}`}
                        onClick={() => onSelectSpace(space.spaceId)}
                        onPointerEnter={() => onHoverSpace(space.spaceId)}
                        onPointerLeave={() => onHoverSpace(null)}
                      >
                        <td>
                          <strong>{space.label}</strong>
                          {space.retired && <span className="muted"> (Retired)</span>}
                        </td>
                        <td>
                          <span className="muted">{space.type}</span>
                        </td>
                        <td>
                          {space.label}: {count} {count === 1 ? 'view' : 'views'}
                        </td>
                        <td>
                          {space.retired ? (
                            <span className="closure-status closure-status--ended">Retired</span>
                          ) : isProposed ? (
                            <span className="closure-status closure-status--scheduled">Proposed</span>
                          ) : outlinedInThisView ? (
                            <span className="closure-status closure-status--active">Outlined</span>
                          ) : (
                            <span className="closure-status closure-status--none">Not outlined</span>
                          )}
                        </td>
                        <td>
                          <div className="ref-table-actions">
                            {isProposed && (
                              <>
                                <button
                                  type="button"
                                  className="button button--primary button--sm"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleAcceptProposal(space.spaceId)
                                  }}
                                  aria-label={`Accept proposal for ${space.label}`}
                                  title={`Accept proposed outline for ${space.label}`}
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  className="button button--ghost button--sm"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleRejectProposal(space.spaceId)
                                  }}
                                  aria-label={`Reject proposal for ${space.label}`}
                                  title={`Reject proposed outline for ${space.label}`}
                                >
                                  Reject
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              className={`button button--sm ${isSelected ? 'button--primary' : 'button--ghost'}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                onSelectSpace(space.spaceId)
                              }}
                            >
                              {isSelected ? 'Selected' : 'Select'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
