import { useEffect, useId, useRef, useState } from 'react'
import { api, errorMessage } from '../api/client'
import { putFile } from '../lib/putFile'
import { sha256Hex } from '../lib/sha256'
import {
  getSvgPoint,
  isValidQuad,
  orderClockwise,
  polygonCenter,
  polygonToSvgPoints,
} from './photo/geom'
import { addSpaceFromOutline, suggestOutline } from './sync'
import type {
  DraftLayout,
  DraftViewpoint,
  Outline,
  Point,
  ReferenceCompleteResponse,
  ReferencePhotoPanelProps,
  ReferenceUploadSlot,
} from './types'

/** Pointer travel (screen px) before a press on the photo becomes a box drag rather than a corner click. */
const BOX_THRESHOLD_PX = 4
/** How soon after a box drag's release a click on the photo is taken to be that release's click. */
const BOX_CLICK_WINDOW_MS = 300
/** Smallest box side, as a fraction of the photo, that counts as a space. */
const MIN_BOX = 0.004

/** The four corners, clockwise from top-left, of the box spanned by two photo points. */
function boxOutline(a: Point, b: Point): Outline | null {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  if (x1 - x0 < MIN_BOX || y1 - y0 < MIN_BOX) return null
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
}

function resolveImageUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (url.startsWith('/api/') || url.startsWith('/_test/')) {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')
    return `${base}${url}`
  }
  return url
}

/** The object a signed URL points at: the URL without its signature (the query string). */
function objectOf(url: string | null): string | null {
  return url?.split('?')[0] ?? null
}

/** A notice that clears itself after `ms`, so old news does not pile up under the photo. */
function useTransientNotice(ms: number) {
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNotice(null), ms)
    return () => clearTimeout(timer)
  }, [notice, ms])
  return [notice, setNotice] as const
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
  onSave,
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
  // A refused outline or corner drag; the next one that works clears it (upload errors stay in errorMsg).
  const [drawError, setDrawError] = useState<string | null>(null)
  const [replaceWarning, setReplaceWarning] = useTransientNotice(8000)
  const [statusNotice, setStatusNotice] = useTransientNotice(4000)

  // Signed URLs change on every draft GET and PUT, but the photo only changes with its object
  // (keys are content-addressed). Once a photo has loaded, keep its URL while the object is the
  // same, so a save neither refetches the photo nor blanks it. Until then, take the newest URL:
  // it replaces one that failed or expired.
  const referenceUrl = currentViewpoint?.referenceImage?.url ?? null
  const [photoSrc, setPhotoSrc] = useState(referenceUrl)
  const [photoState, setPhotoState] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [photoAttempt, setPhotoAttempt] = useState(0)
  if (
    referenceUrl !== photoSrc &&
    (photoState !== 'loaded' || objectOf(referenceUrl) !== objectOf(photoSrc))
  ) {
    setPhotoSrc(referenceUrl)
    setPhotoState('loading')
  }

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

  // A box being dragged out on the photo (two opposite corners), and how to end that drag early.
  const [box, setBox] = useState<[Point, Point] | null>(null)
  const stopBox = useRef<(() => void) | null>(null)
  useEffect(() => () => stopBox.current?.(), [])
  // When a box drag was last released over the photo. The click a mouse sends right after must not place a
  // corner; a touch drag sends none, so the window is short rather than a flag that waits for a click.
  const boxReleasedAt = useRef(-Infinity)

  const selectedSpace = draft.spaces.find((s) => s.spaceId === selectedSpaceId) ?? null
  const selectedOutline =
    (currentViewpoint && selectedSpaceId && currentViewpoint.outlines[selectedSpaceId]) || null
  const selectedReview =
    (currentViewpoint && selectedSpaceId && currentViewpoint.outlineReview?.[selectedSpaceId]) || null
  const isSelectedProposedPending = selectedReview?.status === 'pending'
  // Corners and boxes go to the selected space while it is being outlined; otherwise they add a new space.
  const drawingSelected = Boolean(selectedSpace && !selectedSpace.retired && (isDrawing || clicks.length > 0))
  // Where the selected space should be on this photo, going by the schematic and the spaces already outlined.
  const suggestion =
    currentViewpoint && selectedSpace && !selectedSpace.retired && !selectedOutline
      ? suggestOutline(draft, currentViewpoint, selectedSpace.spaceId)
      : null

  // The server reads the size from the photo itself, so it matches the picture. Every upload and
  // seeded viewpoint records one; the fallback only covers a viewpoint stored without it.
  const svgWidth = currentViewpoint?.referenceImage?.width ?? 1000
  const svgHeight = currentViewpoint?.referenceImage?.height ?? 750

  // When selected space or viewpoint changes, reset clicks and set drawing mode accordingly
  useEffect(() => {
    setClicks([])
    setDrawError(null)
    if (selectedSpace && !selectedSpace.retired && !selectedOutline) {
      setIsDrawing(true)
    } else {
      setIsDrawing(false)
    }
  }, [selectedSpaceId, currentViewId, selectedOutline === null])

  // US-08 #3 "the change is saved to the draft": an outline change (drawn, dragged, deleted,
  // accepted or rejected) is saved as soon as it is made, not left for Save or autosave.
  const commitOutlines = (next: DraftLayout) => {
    onChange(next)
    void onSave?.()
  }

  // Keyboard shortcuts:
  // - Esc: cancel clicks, exit drawing mode, or deselect space
  // - Backspace / Delete / Ctrl+Z: undo last placed point (solves misclicking!)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (clicks.length > 0) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setClicks([])
          setDrawError(null)
          if (selectedOutline) setIsDrawing(false)
        } else if (
          e.key === 'Backspace' ||
          e.key === 'Delete' ||
          ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')
        ) {
          e.preventDefault()
          e.stopImmediatePropagation()
          setClicks((prev) => prev.slice(0, -1))
        }
      } else if (e.key === 'Escape') {
        if (isDrawing) {
          setIsDrawing(false)
        } else if (selectedSpaceId) {
          onSelectSpace(null)
        }
      }
    }
    // Capture phase: this runs before the page's own Ctrl+Z (draft undo) on window, whatever order
    // the two were registered in, so stopImmediatePropagation keeps one key press from undoing a
    // corner and a draft edit.
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [clicks.length, isDrawing, selectedOutline, selectedSpaceId, onSelectSpace])

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
      // A press on a handle without moving it changes nothing, so it must not mark the outline drawn.
      const moved =
        idx !== null &&
        finalCorners !== null &&
        currentViewpoint !== null &&
        selectedSpaceId !== null &&
        finalCorners.some((p, i) => p !== currentViewpoint.outlines[selectedSpaceId]?.[i])
      if (moved && !isValidQuad(finalCorners)) {
        // A corner dragged across the opposite edge: publishing would reject it, so keep the old outline.
        setDrawError('That would cross the outline over itself. Drag the corner back to its side.')
      } else if (moved && currentViewpoint && selectedSpaceId) {
        setDrawError(null)
        // Keep corner handle indices stable without reordering
        const nextOutlines = { ...currentViewpoint.outlines, [selectedSpaceId]: finalCorners }
        // An accepted outline the admin has corrected by hand is theirs: it now anchors the photo <-> schematic
        // fit (sync.ts). A proposal still waiting for review stays one.
        const review = currentViewpoint.outlineReview?.[selectedSpaceId]
        const nextReview =
          review?.status === 'pending'
            ? currentViewpoint.outlineReview
            : { ...currentViewpoint.outlineReview, [selectedSpaceId]: { source: 'drawn' as const, status: 'accepted' as const } }
        const nextVps = draft.viewpoints.map((v) =>
          v.viewId === currentViewpoint.viewId ? { ...v, outlines: nextOutlines, outlineReview: nextReview } : v,
        )
        // commitOutlines, spelled out so this effect's dependencies stay listed
        onChange({ ...draft, viewpoints: nextVps })
        void onSave?.()
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
  }, [draggingIdx, currentViewpoint, selectedSpaceId, draft, onChange, onSave, svgWidth, svgHeight])

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
    void onSave?.().then((saved) => {
      // Viewpoints cannot be removed once saved, and a photo upload needs the viewpoint stored.
      if (!saved) setErrorMsg(`${name} (${nextViewId}) is not saved yet. Save the draft to keep it.`)
    })
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
      if (onSave) {
        const saved = await onSave()
        if (!saved) {
          setIsUploading(false)
          return
        }
      }

      const sha256 = await sha256Hex(file)

      // 1. Reserve slot
      const slot = await api.post<ReferenceUploadSlot>(
        `/admin/lots/${lotId}/views/${currentViewpoint.viewId}/reference`,
        { contentType: file.type, sizeBytes: file.size, sha256 },
      )

      // 2. PUT file with progress
      await putFile(slot.uploadUrl, file, (fraction) => setUploadProgress(fraction))

      // 3. Complete upload; the server reads the photo's size from the file
      const completed = await api.post<ReferenceCompleteResponse>(
        `/admin/lots/${lotId}/views/${currentViewpoint.viewId}/reference/complete`,
        { sha256 },
      )

      if (hadPreviousImage) {
        setReplaceWarning('Check outlines: the photo changed.')
      }

      // The page applies the stored photo to its latest draft and refetches the rest. Do not rebuild
      // the draft here: `draft` is from before the save above, so its revision is stale by now.
      onReferenceUploaded({ lotId, viewId: completed.viewId, referenceImage: completed.referenceImage })
    } catch (err) {
      setErrorMsg(errorMessage(err))
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleReloadPhoto = () => {
    // Remount the image to retry, and fetch fresh signed URLs: an expired one gets a 403.
    setPhotoState('loading')
    setPhotoAttempt((n) => n + 1)
    onReferenceUploaded()
  }

  /** A finished outline (4 clicked corners or a dragged box): the selected space's, or a new space. */
  const finishOutline = (outline: Outline) => {
    if (!currentViewpoint) return
    if (!isValidQuad(outline)) {
      // The first three clicks stay; only the fourth is refused.
      setDrawError('Those corners do not make a four-sided shape. Click a different fourth corner.')
      return
    }
    setDrawError(null)
    setClicks([])
    setIsDrawing(false)
    if (!drawingSelected || !selectedSpace) {
      const { draft: next, space } = addSpaceFromOutline(draft, currentViewpoint.viewId, outline)
      commitOutlines(next)
      onSelectSpace(space.spaceId)
      setStatusNotice(`Added ${space.label} to the schematic. Rename it there if needed.`)
      return
    }
    const nextOutlines = {
      ...currentViewpoint.outlines,
      [selectedSpace.spaceId]: outline,
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
    setStatusNotice(`${selectedSpace.label} outlined in ${currentViewpoint.viewId}`)
    commitOutlines({ ...draft, viewpoints: nextVps })
  }

  // A box drag ends after the render it started in; it finishes with the newest draft and selection.
  const finishOutlineRef = useRef(finishOutline)
  useEffect(() => {
    finishOutlineRef.current = finishOutline
  })

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (performance.now() - boxReleasedAt.current < BOX_CLICK_WINDOW_MS) {
      boxReleasedAt.current = -Infinity
      return
    }
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    if (!currentViewpoint || !svgRef.current) return

    // A click on empty photo while a space is selected (and not being outlined) clears the selection;
    // with nothing selected, clicks place the corners of a new space.
    if (!drawingSelected && clicks.length === 0 && selectedSpace) {
      onSelectSpace(null)
      return
    }

    const point = getSvgPoint(svgRef.current, e.clientX, e.clientY, svgWidth, svgHeight)

    const nextClicks = [...clicks, point]
    if (nextClicks.length < 4) {
      setClicks(nextClicks)
      if (drawingSelected) setIsDrawing(true)
    } else {
      finishOutline(orderClockwise(nextClicks))
    }
  }

  /** Press on empty photo: a drag draws a box (for the space being outlined, or a new one); a click falls through to handleSvgClick. */
  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (e.button !== 0 || clicks.length > 0 || !svg || !currentViewpoint) return
    if ((e.target as Element).closest('.ref-space-polygon:not(.ref-space-polygon--inert), .ref-handles')) return
    stopBox.current?.()
    const { clientX: x0, clientY: y0 } = e
    const start = getSvgPoint(svg, x0, y0, svgWidth, svgHeight)
    let moved = false
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < BOX_THRESHOLD_PX) return
      moved = true
      setBox([start, getSvgPoint(svg, ev.clientX, ev.clientY, svgWidth, svgHeight)])
    }
    const onUp = (ev: PointerEvent) => {
      stop()
      if (!moved) return
      if (ev.target instanceof Node && svg.contains(ev.target)) boxReleasedAt.current = performance.now()
      const outline = boxOutline(start, getSvgPoint(svg, ev.clientX, ev.clientY, svgWidth, svgHeight))
      if (outline) finishOutlineRef.current(outline)
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', stop)
      stopBox.current = null
      setBox(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', stop)
    stopBox.current = stop
  }

  const handleUseSuggestion = () => {
    if (!currentViewpoint || !selectedSpace || !suggestion) return
    const id = selectedSpace.spaceId
    const nextVps = draft.viewpoints.map((v) =>
      v.viewId === currentViewpoint.viewId
        ? {
            ...v,
            outlines: { ...v.outlines, [id]: suggestion },
            outlineReview: { ...v.outlineReview, [id]: { source: 'proposed' as const, status: 'accepted' as const } },
          }
        : v,
    )
    setIsDrawing(false)
    setStatusNotice(`${selectedSpace.label} outlined in ${currentViewpoint.viewId}. Drag its corners to fit.`)
    commitOutlines({ ...draft, viewpoints: nextVps })
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
    commitOutlines({ ...draft, viewpoints: nextVps })
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
    commitOutlines({ ...draft, viewpoints: nextVps })
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
    commitOutlines({ ...draft, viewpoints: nextVps })
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
    commitOutlines({ ...draft, viewpoints: nextVps })
    setStatusNotice(`Accepted ${count} proposed outline${count === 1 ? '' : 's'} in ${currentViewpoint.viewId}`)
  }

  const outlinedCount = Object.keys(currentViewpoint?.outlines ?? {}).length
  const proposedCount = Object.values(currentViewpoint?.outlineReview ?? {}).filter(
    (r) => r.status === 'pending',
  ).length
  const activeSpaces = draft.spaces.filter((s) => !s.retired)
  // Counted per space: an outline kept on a retired space does not stand in for an active one.
  const missingCount = activeSpaces.filter((s) => !currentViewpoint?.outlines[s.spaceId]).length

  // Find next unmapped space for streamlined sequence progression
  const nextUnmappedSpace =
    activeSpaces.find((s) => s.spaceId !== selectedSpaceId && !currentViewpoint?.outlines[s.spaceId]) ?? null

  // When user is actively placing points or in drawing mode, existing polygons MUST NOT intercept clicks!
  const isActivelyDrawing = isDrawing || clicks.length > 0

  // Nothing produces proposed outlines yet (HDD §4.6, wave 3), so "Propose" is a test hook for the
  // review flow. A production build leaves it out: a pending outline blocks publishing.
  const canProposeOutlines = import.meta.env.DEV

  const notices = (
    <>
      {errorMsg && (
        <p className="notice notice--error" role="alert">
          {errorMsg}
        </p>
      )}
      {drawError && (
        <p className="notice notice--error" role="alert">
          {drawError}
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
    </>
  )

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

      {/* With a photo, the notices sit under it (see ref-panel__status) */}
      {!currentViewpoint?.referenceImage && notices}

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
          {/* Photo viewer with SVG overlay */}
          <div
            className="photo-view"
            style={{ aspectRatio: `${svgWidth} / ${svgHeight}` }}
          >
            <img
              key={photoAttempt}
              src={resolveImageUrl(photoSrc)}
              alt={`Reference for ${currentViewpoint.name}`}
              className="photo-view__img"
              style={{ aspectRatio: `${svgWidth} / ${svgHeight}`, objectFit: 'contain' }}
              onLoad={() => setPhotoState('loaded')}
              onError={() => setPhotoState('error')}
            />
            <svg
              ref={svgRef}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              preserveAspectRatio="none"
              className={`photo-view__overlay ${isActivelyDrawing || !selectedSpace ? 'photo-view__overlay--drawing' : ''}`}
              onClick={handleSvgClick}
              onPointerDown={handleSvgPointerDown}
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

              {/* Where the selected space should be, going by the schematic */}
              {suggestion && clicks.length === 0 && (
                <polygon
                  className="ref-suggestion"
                  data-testid="suggested-outline"
                  points={polygonToSvgPoints(suggestion, svgWidth, svgHeight)}
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {/* A box being dragged out */}
              {box && (
                <rect
                  className="ref-drawbox"
                  data-testid="photo-drawbox"
                  x={Math.min(box[0][0], box[1][0]) * svgWidth}
                  y={Math.min(box[0][1], box[1][1]) * svgHeight}
                  width={Math.abs(box[1][0] - box[0][0]) * svgWidth}
                  height={Math.abs(box[1][1] - box[0][1]) * svgHeight}
                  vectorEffect="non-scaling-stroke"
                />
              )}

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
            {photoState === 'loading' && (
              <p className="photo-view__loading" role="status">
                Loading photo…
              </p>
            )}
            {photoState === 'error' && (
              <div className="photo-view__error" role="alert">
                <p>The reference photo did not load. Its link may have expired.</p>
                <button type="button" className="button button--primary button--sm" onClick={handleReloadPhoto}>
                  Reload photo
                </button>
              </div>
            )}
          </div>

          {/* Everything that changes while outlining sits under the photo, so the photo never
              moves between the corners an admin aims at. */}
          <div className="ref-panel__status">
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
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        onClick={() => {
                          setClicks([])
                          setIsDrawing(false)
                          onSelectSpace(null)
                        }}
                        title="Done outlining; deselect space"
                        data-testid="done-drawing-btn"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}

                {/* State B: In drawing/redraw mode, waiting for 1st click */}
                {clicks.length === 0 && isDrawing && (
                  <div className="notice ref-prompt" data-testid="outline-prompt" role="status">
                    <div className="ref-prompt__msg">
                      <span>Click the 4 corners of {selectedSpace.label} (0 of 4)</span>
                      <span className="ref-prompt__hint">· or drag a box</span>
                      {selectedOutline && (
                        <span className="ref-prompt__hint">
                          · Redrawing outline · Existing outline will be replaced
                        </span>
                      )}
                    </div>
                    <div className="ref-prompt__actions">
                      {suggestion && (
                        <button
                          type="button"
                          className="button button--primary button--sm"
                          onClick={handleUseSuggestion}
                          title="Use the dashed outline projected from the schematic"
                          data-testid="use-suggestion-btn"
                        >
                          Use suggested outline
                        </button>
                      )}
                      {selectedOutline && (
                        <button
                          type="button"
                          className="button button--ghost button--sm"
                          onClick={() => setIsDrawing(false)}
                        >
                          Cancel redraw
                        </button>
                      )}
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        onClick={() => {
                          setIsDrawing(false)
                          setClicks([])
                          onSelectSpace(null)
                        }}
                        title="Done outlining; deselect space"
                        data-testid="done-drawing-btn"
                      >
                        Done
                      </button>
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
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        onClick={() => {
                          setIsDrawing(false)
                          setClicks([])
                          onSelectSpace(null)
                        }}
                        title="Done; deselect space"
                        data-testid="done-drawing-btn"
                      >
                        Done
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
                      {canProposeOutlines && (
                        <button
                          type="button"
                          className="button button--ghost button--sm"
                          onClick={() => handleProposeOutline(selectedSpace.spaceId)}
                          title="Mark outline as proposed for testing review workflow"
                        >
                          Propose
                        </button>
                      )}
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        onClick={() => handleDeleteOutline(selectedSpace.spaceId)}
                      >
                        Delete outline
                      </button>
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        onClick={() => {
                          setIsDrawing(false)
                          setClicks([])
                          onSelectSpace(null)
                        }}
                        title="Done; deselect space"
                        data-testid="done-drawing-btn"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {!selectedSpace && clicks.length > 0 && (
              <div className="notice ref-prompt" data-testid="new-space-prompt" role="status">
                <div className="ref-prompt__msg">
                  <span>Click the 4 corners of the new space ({clicks.length} of 4)</span>
                  <span className="ref-prompt__hint">
                    · Press <strong>Backspace</strong> to undo · <strong>Esc</strong> to cancel
                  </span>
                </div>
                <div className="ref-prompt__actions">
                  <button type="button" className="button button--ghost button--sm" onClick={handleUndoPoint}>
                    ↶ Undo point
                  </button>
                  <button type="button" className="button button--ghost button--sm" onClick={() => setClicks([])}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {!selectedSpace && clicks.length === 0 && (
              <div className="notice ref-prompt" role="status">
                <span>
                  Select a space to outline it, or drag a box (or click 4 corners) on the photo to add a new space.
                </span>
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
            {notices}
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
              Select a space from the table or photo to outline it. Drag a box or click 4 corners on empty photo to add a
              space: it appears in the schematic where the photo says it is. Press <strong>Backspace</strong> to undo a
              point. Drag handles to fine-tune.
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
