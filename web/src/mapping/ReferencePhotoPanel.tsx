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
import { addSpaceFromOutline, followOutline, suggestOutline } from './sync'
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

/** Keep a move of all `pts` by `d` on the photo: the move is cut short at the edge, so the shape holds. */
function clampMove(pts: Point[], d: Point): Point {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [
    Math.min(Math.max(d[0], -Math.min(...xs)), 1 - Math.max(...xs)),
    Math.min(Math.max(d[1], -Math.min(...ys)), 1 - Math.max(...ys)),
  ]
}

const round4 = (v: number) => Number(v.toFixed(4))

/**
 * The outline while a drag is at photo point `p`: a corner goes to `p`; a side moves straight out or in
 * (along its normal, measured in photo pixels so a non-square photo doesn't skew it); the body moves by
 * the drag. Corners that don't move keep their identity, so an unmoved drag can be told apart.
 */
function reshape(
  spec: { kind: 'corner' | 'side' | 'body'; idx: number; start: Point; from: Outline },
  p: Point,
  width: number,
  height: number,
): Outline {
  const { kind, idx, start, from } = spec
  if (kind === 'corner') return from.map((c, i) => (i === idx ? p : c))
  const d: Point = [p[0] - start[0], p[1] - start[1]]
  const moving = kind === 'body' ? [0, 1, 2, 3] : [idx, (idx + 1) % from.length]
  let step = d
  if (kind === 'side') {
    const [a, b] = moving.map((i) => from[i])
    const ex = (b[0] - a[0]) * width
    const ey = (b[1] - a[1]) * height
    const len = Math.hypot(ex, ey) || 1
    const [nx, ny] = [-ey / len, ex / len]
    const along = d[0] * width * nx + d[1] * height * ny
    step = [(nx * along) / width, (ny * along) / height]
  }
  const [dx, dy] = clampMove(
    moving.map((i) => from[i]),
    step,
  )
  return from.map((c, i) => (moving.includes(i) ? [round4(c[0] + dx), round4(c[1] + dy)] : c))
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
  snapGrid = null,
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

  // Reshaping the selected outline: a corner handle moves one corner, a side handle moves a whole side
  // (resizing the box), and the outline itself moves all four. The shape is worked out from where the
  // drag started, so it never drifts.
  const [dragging, setDragging] = useState(false)
  const [dragCorners, setDragCorners] = useState<Outline | null>(null)
  const dragSpecRef = useRef<{ kind: 'corner' | 'side' | 'body'; idx: number; start: Point; from: Outline } | null>(null)
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
  const commitOutlines = (next: DraftLayout, shift?: { dx: number; dy: number }) => {
    onChange(next, shift && (shift.dx !== 0 || shift.dy !== 0) ? shift : undefined)
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

  // Zoom into the photo: the stage holding the photo and its outlines is scaled by k and shifted by
  // (tx, ty) screen pixels inside the frame. Ctrl/Cmd + scroll zooms at the pointer; scrolling or a
  // middle-button drag pans while zoomed. Each viewpoint starts unzoomed.
  const frameRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState({ viewId: currentViewId, k: 1, tx: 0, ty: 0 })
  const view = zoom.viewId === currentViewId ? zoom : { viewId: currentViewId, k: 1, tx: 0, ty: 0 }
  /** Keep the zoomed photo covering the frame. */
  const clampZoom = (k: number, tx: number, ty: number) => {
    const box = frameRef.current?.getBoundingClientRect()
    const w = box?.width ?? 0
    const h = box?.height ?? 0
    return { viewId: currentViewId, k, tx: Math.min(0, Math.max(w - w * k, tx)), ty: Math.min(0, Math.max(h - h * k, ty)) }
  }
  /** Zoom by `factor` (1x to 8x) keeping the photo point under (clientX, clientY), or the middle, still. */
  const zoomPhoto = (factor: number, clientX?: number, clientY?: number) => {
    const box = frameRef.current?.getBoundingClientRect()
    if (!box) return
    const px = (clientX ?? box.left + box.width / 2) - box.left
    const py = (clientY ?? box.top + box.height / 2) - box.top
    const k = Math.min(8, Math.max(1, view.k * factor))
    setZoom(clampZoom(k, px - ((px - view.tx) / view.k) * k, py - ((py - view.ty) / view.k) * k))
  }
  const panPhoto = (dx: number, dy: number) => setZoom(clampZoom(view.k, view.tx + dx, view.ty + dy))
  const zoomRef = useRef({ zoomPhoto, panPhoto, k: view.k })
  useEffect(() => {
    zoomRef.current = { zoomPhoto, panPhoto, k: view.k }
  })
  const hasPhoto = Boolean(currentViewpoint?.referenceImage)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    // React's onWheel is passive; preventDefault needs a native listener.
    const onWheel = (e: WheelEvent) => {
      const { zoomPhoto: z, panPhoto: p, k } = zoomRef.current
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        z(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
      } else if (k > 1) {
        e.preventDefault()
        p(-e.deltaX, -e.deltaY)
      }
    }
    frame.addEventListener('wheel', onWheel, { passive: false })
    return () => frame.removeEventListener('wheel', onWheel)
  }, [hasPhoto])
  const stopPan = useRef<(() => void) | null>(null)
  useEffect(() => () => stopPan.current?.(), [])
  const startPhotoPan = (e: React.PointerEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    stopPan.current?.()
    let last = [e.clientX, e.clientY]
    const onMove = (ev: PointerEvent) => {
      zoomRef.current.panPhoto(ev.clientX - last[0], ev.clientY - last[1])
      last = [ev.clientX, ev.clientY]
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      stopPan.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    stopPan.current = stop
  }

  // Photo units per screen pixel. The photo is drawn far smaller than its pixel size (a 2000 px drone
  // photo in a 600 px panel), so handles and markers are sized from this to stay grabbable on screen.
  const [unitsPerPx, setUnitsPerPx] = useState(1)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const measure = () => {
      const w = svg.getBoundingClientRect().width
      if (w > 0) setUnitsPerPx(svgWidth / w)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [svgWidth, hasPhoto, view.k])

  // Global pointer listeners while reshaping the selected outline
  useEffect(() => {
    if (!dragging) return

    const handlePointerMove = (e: PointerEvent) => {
      const spec = dragSpecRef.current
      if (!spec || !svgRef.current) return
      justDraggedRef.current = true
      const p = getSvgPoint(svgRef.current, e.clientX, e.clientY, svgWidth, svgHeight)
      const updated = reshape(spec, p, svgWidth, svgHeight)
      dragCornersRef.current = updated
      setDragCorners(updated)
    }

    const handlePointerUp = () => {
      const finalCorners = dragCornersRef.current
      // A drag that ends where it began (or pushes against the photo edge) changes nothing, so it must
      // not mark the outline drawn or move the schematic.
      const stored = currentViewpoint && selectedSpaceId ? currentViewpoint.outlines[selectedSpaceId] : undefined
      const moved =
        finalCorners !== null &&
        currentViewpoint !== null &&
        selectedSpaceId !== null &&
        finalCorners.some((p, i) => !stored?.[i] || p[0] !== stored[i][0] || p[1] !== stored[i][1])
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
        // The schematic rect (and the other photos) follow the outline.
        const followed = followOutline(draft, { ...draft, viewpoints: nextVps }, currentViewpoint.viewId, selectedSpaceId, snapGrid)
        if (followed.note) setStatusNotice(followed.note)
        // commitOutlines, spelled out so this effect's dependencies stay listed
        onChange(followed.draft, followed.dx !== 0 || followed.dy !== 0 ? { dx: followed.dx, dy: followed.dy } : undefined)
        void onSave?.()
      }
      dragSpecRef.current = null
      dragCornersRef.current = null
      setDragging(false)
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
  }, [dragging, currentViewpoint, selectedSpaceId, draft, onChange, onSave, svgWidth, svgHeight, snapGrid, setStatusNotice])

  /** Start reshaping the selected outline from a handle or the outline itself. */
  const startOutlineDrag = (e: React.PointerEvent, kind: 'corner' | 'side' | 'body', idx: number) => {
    if (e.button !== 0 || !selectedOutline || !svgRef.current) return
    e.stopPropagation()
    e.preventDefault()
    const from = [...selectedOutline]
    dragSpecRef.current = { kind, idx, start: getSvgPoint(svgRef.current, e.clientX, e.clientY, svgWidth, svgHeight), from }
    dragCornersRef.current = from
    setDragCorners(from)
    setDragging(true)
    justDraggedRef.current = false
  }

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
      const { draft: next, space, dx, dy } = addSpaceFromOutline(draft, currentViewpoint.viewId, outline, snapGrid)
      commitOutlines(next, { dx, dy })
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
    // A redrawn outline moves the space on the schematic the same way; a first outline moves nothing.
    const followed = followOutline(draft, { ...draft, viewpoints: nextVps }, currentViewpoint.viewId, selectedSpace.spaceId, snapGrid)
    setStatusNotice(followed.note ?? `${selectedSpace.label} outlined in ${currentViewpoint.viewId}`)
    commitOutlines(followed.draft, followed)
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
            ref={frameRef}
            className="photo-view"
            style={{ aspectRatio: `${svgWidth} / ${svgHeight}` }}
            onPointerDown={startPhotoPan}
            // The browser's middle-click autoscroll starts on mousedown, not pointerdown.
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault()
            }}
          >
            <div
              className="photo-view__stage"
              style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})` }}
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
                    onPointerDown={(e) => {
                      // The selected outline moves as a whole when dragged; a click still just selects.
                      if (isSelected && !isActivelyDrawing) startOutlineDrag(e, 'body', 0)
                    }}
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
                      fontSize={12 * unitsPerPx}
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

              {/* Handles for the selected outline (when not clicking new points): corners reshape it, the
                  squares on its sides move a whole side. Each has a wider invisible ring to grab. */}
              {selectedSpaceId && selectedOutline && clicks.length === 0 && !isDrawing && (
                <g className="ref-handles" data-testid="selected-corner-handles">
                  {(dragCorners ?? selectedOutline).map((corner, idx, pts) => {
                    const next = pts[(idx + 1) % pts.length]
                    const mx = ((corner[0] + next[0]) / 2) * svgWidth
                    const my = ((corner[1] + next[1]) / 2) * svgHeight
                    // A small outline on screen gets smaller grab rings, so a corner's ring never covers
                    // the side handle next to it. Zooming in makes them full size again.
                    const shortest = Math.min(
                      ...pts.map((p, i) => {
                        const q = pts[(i + 1) % pts.length]
                        return Math.hypot((q[0] - p[0]) * svgWidth, (q[1] - p[1]) * svgHeight) / unitsPerPx
                      }),
                    )
                    const hitPx = Math.min(14, Math.max(4, shortest / 4))
                    const side = Math.min(9, Math.max(4, shortest / 4)) * unitsPerPx
                    const stop = (e: React.MouseEvent) => {
                      e.stopPropagation()
                      e.preventDefault()
                    }
                    return (
                      <g key={idx}>
                        <g
                          className="ref-handle ref-handle--side"
                          data-testid={`side-handle-${idx}`}
                          onPointerDown={(e) => startOutlineDrag(e, 'side', idx)}
                          onClick={stop}
                        >
                          <circle className="ref-handle__hit" cx={mx} cy={my} r={hitPx * unitsPerPx} />
                          <rect x={mx - side / 2} y={my - side / 2} width={side} height={side} rx={side * 0.2} />
                        </g>
                        <g
                          className="ref-handle"
                          data-testid={`corner-handle-${idx}`}
                          onPointerDown={(e) => startOutlineDrag(e, 'corner', idx)}
                          onClick={stop}
                        >
                          <circle className="ref-handle__hit" cx={corner[0] * svgWidth} cy={corner[1] * svgHeight} r={hitPx * unitsPerPx} />
                          <circle cx={corner[0] * svgWidth} cy={corner[1] * svgHeight} r={Math.min(6, hitPx * 0.6) * unitsPerPx} />
                        </g>
                      </g>
                    )
                  })}
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
                        r={11 * unitsPerPx}
                        fill="var(--accent)"
                        stroke="#ffffff"
                        strokeWidth={2}
                      />
                      <text
                        x={pt[0] * svgWidth}
                        y={pt[1] * svgHeight}
                        fill="#ffffff"
                        fontSize={11 * unitsPerPx}
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
            <div className="photo-zoom" role="group" aria-label="Photo zoom">
              <button type="button" className="button button--sm" aria-label="Zoom photo out" onClick={() => zoomPhoto(1 / 1.5)} disabled={view.k <= 1}>
                −
              </button>
              <span className="photo-zoom__level">{Math.round(view.k * 100)}%</span>
              <button type="button" className="button button--sm" aria-label="Zoom photo in" onClick={() => zoomPhoto(1.5)} disabled={view.k >= 8}>
                +
              </button>
              <button type="button" className="button button--sm" onClick={() => setZoom({ viewId: currentViewId, k: 1, tx: 0, ty: 0 })} disabled={view.k === 1}>
                Fit
              </button>
            </div>
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
