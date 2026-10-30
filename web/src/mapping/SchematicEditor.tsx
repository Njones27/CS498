import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { addRow, addSpace, canDeleteSpace, deleteSpace, fitSchematic, updateSpace, type Grown } from './schematic/edits'
import {
  CORNERS,
  MARGIN,
  MIN_SIDE,
  maxRowCount,
  moveRect,
  resizeRect,
  sameRect,
  unionBounds,
  type Bounds,
  type Corner,
} from './schematic/geometry'
import {
  alignToCells,
  applyLabels,
  cellAt,
  cellLabel,
  cellRect,
  cellTaken,
  cellsIn,
  insertAtRowStart,
  labelDigits,
  gridInView,
  gridSizes,
  relabelMoved,
  rowLetter,
  snapMove,
  snapResize,
  type Cell,
  type Grid,
  type GridSizes,
} from './schematic/grid'
import { duplicateLabelIds, nextRowStart, parseLabel, type ParsedLabel } from './schematic/labels'
import { addSpaceOnSchematic, addSpacesInCells, afterRectChange, dropPendingProposals, photoToSchematic, proposeOutlines } from './sync'
import type { GridControls } from './useSchematicGrid'
import type { DraftLayout, DraftRect, DraftSpace, Issue, MapShift, MappingSelection, Point, SpaceType } from './types'

export interface SchematicEditorProps extends MappingSelection {
  draft: DraftLayout
  onChange: (next: DraftLayout, shift?: MapShift) => void
  issues: Issue[] // from the last validation; affected spaces are outlined in red
  /**
   * Optional: ids of spaces in any published version, which can only be retired. Without it, the
   * spaces the draft had when the editor first showed this lot and version count as published.
   */
  publishedSpaceIds?: ReadonlySet<string>
  /** The page's grid (useSchematicGrid). Without it there is no grid and nothing snaps. */
  grid?: GridControls | null
  /** The last edit made elsewhere (the photo) that moved every space; `n` counts them. A pinned view follows. */
  externalShift?: MapShift & { n: number }
}

const TYPES: { value: SpaceType; label: string; spoken: string }[] = [
  { value: 'STANDARD', label: 'Standard', spoken: 'standard' },
  { value: 'ADA', label: 'ADA', spoken: 'ADA' },
  { value: 'EV', label: 'EV', spoken: 'EV' },
]
const SPOKEN = Object.fromEntries(TYPES.map((t) => [t.value, t.spoken])) as Record<SpaceType, string>

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

const DUPLICATE_NOTE = 'Label already used'
/** Pointer travel (screen px) before a press on a space becomes a drag, so a click never nudges it. */
const DRAG_THRESHOLD_PX = 3

type DragMode = 'move' | Corner

/** The part of the schematic on screen (the SVG viewBox), in schematic units. */
interface Camera {
  x: number
  y: number
  w: number
  h: number
}

/** What a drag on empty schematic does: move the view, or draw a new space. */
type Tool = 'pan' | 'draw'

const ZOOM_STEP = 1.25
const MIN_ZOOM = 0.25
const MAX_ZOOM = 20

/** The whole map area plus a margin around it, so a space can be dragged past the edge to grow the map. */
function fitCamera(width: number, height: number): Camera {
  const pad = Math.max(2 * MARGIN, 0.06 * Math.max(width, height))
  return { x: -pad, y: -pad, w: width + 2 * pad, h: height + 2 * pad }
}

const cameraBounds = (c: Camera): Bounds => ({ x: c.x, y: c.y, width: c.w, height: c.h })

/** The rectangle spanned by two corners, snapped to whole units. */
function spanRect(a: Point, b: Point): DraftRect {
  const x = Math.round(Math.min(a[0], b[0]))
  const y = Math.round(Math.min(a[1], b[1]))
  return { x, y, w: Math.round(Math.max(a[0], b[0])) - x, h: Math.round(Math.max(a[1], b[1])) - y }
}

function describe(space: DraftSpace, duplicate: boolean): string {
  const parts = [space.label.trim() || 'Unlabeled space', SPOKEN[space.type]]
  if (space.retired) parts.push('retired')
  if (duplicate) parts.push(DUPLICATE_NOTE.toLowerCase())
  return parts.join(', ')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Schematic editor (US-07): draw, label, type, move, resize and retire the draft's spaces. Never calls the API. */
export function SchematicEditor({
  draft,
  onChange,
  issues,
  publishedSpaceIds,
  grid,
  externalShift,
  selectedSpaceId,
  onSelectSpace,
  hoveredSpaceId,
  onHoverSpace,
}: SchematicEditorProps) {
  const { width, height } = draft.schematic
  const svgRef = useRef<SVGSVGElement>(null)
  const [preview, setPreview] = useState<{ spaceId: string; rect: DraftRect } | null>(null)
  // null follows the map area as it grows; zooming or panning pins the view.
  const [camera, setCamera] = useState<Camera | null>(null)
  const fit = fitCamera(width, height)
  const view = camera ?? fit
  const [tool, setTool] = useState<Tool>('pan')
  const [drawBox, setDrawBox] = useState<DraftRect | null>(null)
  // With snapping on, a box drawn on the map previews the cells it will fill.
  const [drawCells, setDrawCells] = useState<Cell[] | null>(null)
  const snapGrid = grid?.snap ? grid.grid : null
  const [rowOpen, setRowOpen] = useState(false)
  const [note, setNote] = useState('')
  const noteId = useId()

  // A drag listens on window; it reads the latest draft and callback when the pointer is released.
  const latest = useRef({ draft, onChange, snapGrid, grid: grid?.grid ?? null })
  useEffect(() => {
    latest.current = { draft, onChange, snapGrid, grid: grid?.grid ?? null }
  })
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])

  // Spaces already in the draft when the editor first showed this lot and version may be published.
  const baseKey = `${draft.lotId}:${draft.basedOnVersion}`
  const [baseline, setBaseline] = useState(() => ({ key: baseKey, ids: new Set(draft.spaces.map((s) => s.spaceId)) }))
  if (baseline.key !== baseKey) setBaseline({ key: baseKey, ids: new Set(draft.spaces.map((s) => s.spaceId)) })
  const publishedIds = publishedSpaceIds ?? baseline.ids

  const duplicates = useMemo(() => duplicateLabelIds(draft.spaces), [draft.spaces])
  const issueIds = useMemo(() => new Set(issues.flatMap((i) => i.spaceIds)), [issues])
  const selected = draft.spaces.find((s) => s.spaceId === selectedSpaceId) ?? null
  const retiredCount = draft.spaces.filter((s) => s.retired).length
  const summary =
    plural(draft.spaces.length - retiredCount, 'space') + (retiredCount > 0 ? `, ${retiredCount} retired` : '')

  /** Schematic units per screen pixel (the SVG keeps its aspect ratio); 1 where layout is unknown, as in tests. */
  function unitsPerPixel(): number {
    const box = svgRef.current?.getBoundingClientRect()
    return box && box.width > 0 && box.height > 0 ? Math.max(view.w / box.width, view.h / box.height) : 1
  }

  /** A screen point in schematic units, allowing for the letterboxing of preserveAspectRatio="xMidYMid meet". */
  function toUnits(clientX: number, clientY: number): Point {
    const box = svgRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0 || box.height <= 0) return [view.x + clientX, view.y + clientY]
    const scale = unitsPerPixel()
    const left = box.left + (box.width - view.w / scale) / 2
    const top = box.top + (box.height - view.h / scale) / 2
    return [view.x + (clientX - left) * scale, view.y + (clientY - top) * scale]
  }

  /** Where a dragged space may go: anywhere on the map or on screen. Past the map edge, the map grows. */
  const dragBounds = () => unionBounds(draft.schematic, cameraBounds(view))

  /** Send an edit that may have grown the map; a pinned view shifts with the spaces so nothing jumps. */
  function emitGrown({ draft: next, dx, dy }: Grown, emit: SchematicEditorProps['onChange'] = onChange) {
    emit(next, dx !== 0 || dy !== 0 ? { dx, dy } : undefined)
    if (dx !== 0 || dy !== 0) setCamera((c) => c && { ...c, x: c.x + dx, y: c.y + dy })
  }

  // An edit on the photo that grew the map left or up moved every space; a pinned view moves with them.
  const [seenShift, setSeenShift] = useState(externalShift?.n ?? 0)
  if (externalShift && externalShift.n !== seenShift) {
    setSeenShift(externalShift.n)
    setCamera((c) => c && { ...c, x: c.x + externalShift.dx, y: c.y + externalShift.dy })
  }

  /** Zoom by `factor` around `center` (schematic units), between MIN_ZOOM and MAX_ZOOM of the fitted view. */
  function zoomAt(factor: number, center?: Point) {
    setCamera((c) => {
      const v = c ?? fit
      const [cx, cy] = center ?? [v.x + v.w / 2, v.y + v.h / 2]
      const w = Math.min(fit.w / MIN_ZOOM, Math.max(fit.w / MAX_ZOOM, v.w / factor))
      const k = w / v.w
      return { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w, h: v.h * k }
    })
  }

  // Ctrl/Cmd + wheel (and trackpad pinch, which arrives as Ctrl + wheel) zooms at the pointer. A plain
  // wheel still scrolls the page. React's onWheel is passive, so preventDefault needs a native listener.
  const zoomRef = useRef({ zoomAt, toUnits })
  useEffect(() => {
    zoomRef.current = { zoomAt, toUnits }
  })
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const { zoomAt: zoom, toUnits: units } = zoomRef.current
      zoom(Math.exp(-e.deltaY * 0.01), units(e.clientX, e.clientY))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  /**
   * Press on empty schematic: a click clears the selection; a drag pans (Pan tool, or the middle
   * button) or draws a new space (Draw tool).
   */
  function startBackground(e: ReactPointerEvent) {
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    stopDrag.current?.()
    const mode: Tool = e.button === 1 ? 'pan' : tool
    const { clientX: x0, clientY: y0 } = e
    const scale = unitsPerPixel()
    const v0 = view
    const start = toUnits(x0, y0)
    let moved = false
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return
      moved = true
      if (mode === 'pan') setCamera({ ...v0, x: v0.x - (ev.clientX - x0) * scale, y: v0.y - (ev.clientY - y0) * scale })
      else if (snapGrid) setDrawCells(cellsIn(snapGrid, start, toUnits(ev.clientX, ev.clientY)))
      else setDrawBox(spanRect(start, toUnits(ev.clientX, ev.clientY)))
    }
    const onUp = (ev: PointerEvent) => {
      stop()
      if (!moved) return onSelectSpace(null)
      if (mode !== 'draw') return
      if (snapGrid) return fillCells(cellsIn(snapGrid, start, toUnits(ev.clientX, ev.clientY)))
      const rect = spanRect(start, toUnits(ev.clientX, ev.clientY))
      if (rect.w < MIN_SIDE || rect.h < MIN_SIDE) return setNote(`Too small: drag a box at least ${MIN_SIDE} units wide and tall`)
      const added = addSpaceOnSchematic(latest.current.draft, rect)
      emitGrown(added, latest.current.onChange)
      onSelectSpace(added.space.spaceId)
      setNote(`Added ${added.space.label}`)
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', stop)
      stopDrag.current = null
      setDrawBox(null)
      setDrawCells(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', stop)
    stopDrag.current = stop
  }

  /** Snapping on, a drawn box: one new space per free cell it covers, named for the cell. */
  function fillCells(cells: Cell[]) {
    const { draft: current, onChange: emit, snapGrid: g } = latest.current
    if (!g) return
    if (cells.length === 0) return setNote('That box covers too many cells; draw a smaller one')
    const added = addSpacesInCells(current, g, cells)
    if (added.spaces.length === 0) return setNote('Those cells already have spaces (or are outside the lettered rows)')
    emitGrown(added, emit)
    onSelectSpace(added.spaces[0].spaceId)
    const first = added.spaces[0].label
    const last = added.spaces[added.spaces.length - 1].label
    setNote(added.spaces.length === 1 ? `Added ${first}` : `Added ${added.spaces.length} spaces, ${first} to ${last}`)
  }

  /**
   * Commit a moved or resized space: its photo outlines follow and the map grows to hold it. A space
   * moved into another cell is renamed for it, row letter and column number; see relabelMoved. `cell` is
   * the cell a snapped move put it in.
   */
  function commitRect(
    current: DraftLayout,
    emit: SchematicEditorProps['onChange'],
    spaceId: string,
    rect: DraftRect,
    cell: Cell | null,
    isMove: boolean,
  ) {
    // Never stack two spaces in one cell.
    const g = latest.current.snapGrid
    if (cell && g && cellTaken(g, current.spaces, cell, null, spaceId)) {
      const there = current.spaces.find((s) => {
        if (s.retired || s.spaceId === spaceId) return false
        const c = cellAt(g, [s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2])
        return c.row === cell.row && c.col === cell.col
      })
      return setNote(`That cell already has ${there?.label.trim() || 'a space'}; nothing moved`)
    }
    const was = current.spaces.find((s) => s.spaceId === spaceId)
    const gr = latest.current.grid
    const to = cell ?? (gr && cellAt(gr, [rect.x + rect.w / 2, rect.y + rect.h / 2]))
    const from = gr && was && cellAt(gr, [was.rect.x + was.rect.w / 2, was.rect.y + was.rect.h / 2])
    // Only a move renames, and only into another cell: a resize, or a drag back to the same cell, keeps the label.
    const rename = gr && isMove && to && from && (from.row !== to.row || from.col !== to.col)
    // Moved into the cell just before a row's first number: it becomes 01 and the rest of that row moves
    // up one to make room. A space that isn't numbered in the way blocks that, and the move is undone.
    const canInsert = rename && to.col === -1 && to.row >= 0 && was && (!was.label.trim() || parseLabel(was.label) !== null)
    const inserted = canInsert ? insertAtRowStart(current, gr, spaceId, to.row) : null
    if (canInsert && !inserted) {
      return setNote(
        `Row ${rowLetter(to.row)} can't move up to make room: a space is in the way of column 1 (or this is already its 01); nothing moved`,
      )
    }
    const relabel = rename && !inserted ? relabelMoved(gr, current.spaces, spaceId, to) : { labels: new Map<string, string>() }
    const edited = inserted ?? applyLabels(updateSpace(current, spaceId, { rect }), relabel.labels)
    const grown = afterRectChange(current, edited, [spaceId])
    if (inserted) {
      const label = inserted.spaces.find((s) => s.spaceId === spaceId)!.label
      relabel.note = `Now ${label}; the rest of row ${rowLetter(to.row)} moved up one to make room`
    }
    emitGrown(grown, emit)
    // followRects leaves an outline as it was when the new spot is off that photo (or would fold it).
    const stuck =
      was &&
      !sameRect(was.rect, rect) &&
      current.viewpoints.some((v) => {
        const outline = v.outlines[spaceId]
        const unmoved = outline && grown.draft.viewpoints.find((n) => n.viewId === v.viewId)?.outlines[spaceId] === outline
        // Without a fit (too few outlined spaces) nothing follows, which is not about the spot.
        return unmoved && photoToSchematic(current, v) !== null
      })
    const notes = [relabel.note]
    if (stuck) notes.push('its photo outline stays where it is: the new spot is off the photo')
    setNote(notes.filter(Boolean).join('; '))
  }

  /** Press on a space (move) or a corner handle (resize). Selects at once; emits one onChange on release. */
  function startDrag(e: ReactPointerEvent, space: DraftSpace, mode: DragMode) {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelectSpace(space.spaceId)
    if (space.retired) return
    stopDrag.current?.()
    const scale = unitsPerPixel()
    const { clientX: x0, clientY: y0 } = e
    const origin = space.rect
    const bounds = dragBounds()
    let moved = false
    // With snapping on, a move lands in the cell under the space's middle and a resize on box edges.
    const placeAt = (ev: PointerEvent): { rect: DraftRect; cell: Cell | null } => {
      const dx = (ev.clientX - x0) * scale
      const dy = (ev.clientY - y0) * scale
      if (mode === 'move') {
        const free = moveRect(origin, dx, dy, bounds)
        return snapGrid ? snapMove(snapGrid, free) : { rect: free, cell: null }
      }
      const free = resizeRect(origin, mode, dx, dy, bounds)
      return { rect: snapGrid ? snapResize(snapGrid, free, mode) : free, cell: null }
    }
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return
      moved = true
      setPreview({ spaceId: space.spaceId, rect: placeAt(ev).rect })
    }
    const onUp = (ev: PointerEvent) => {
      stop()
      if (!moved) return
      const { rect, cell } = placeAt(ev)
      const { draft: current, onChange: emit } = latest.current
      const now = current.spaces.find((s) => s.spaceId === space.spaceId)
      if (now && (!sameRect(rect, now.rect) || cell)) commitRect(current, emit, space.spaceId, rect, cell, mode === 'move')
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', stop)
      stopDrag.current = null
      setPreview(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', stop)
    stopDrag.current = stop
  }

  /** Arrow keys move the selected space by 1 unit, 10 with Shift; with snapping on, by one cell. */
  function onSvgKeyDown(e: ReactKeyboardEvent<SVGSVGElement>) {
    const step = ARROWS[e.key]
    if (!step || !selected || selected.retired) return
    e.preventDefault()
    if (snapGrid) {
      const from = cellAt(snapGrid, [selected.rect.x + selected.rect.w / 2, selected.rect.y + selected.rect.h / 2])
      const cell = { row: from.row + step[1], col: from.col + step[0] }
      return commitRect(draft, onChange, selected.spaceId, cellRect(snapGrid, cell), cell, true)
    }
    const n = e.shiftKey ? 10 : 1
    const rect = moveRect(selected.rect, step[0] * n, step[1] * n, dragBounds())
    if (!sameRect(rect, selected.rect)) commitRect(draft, onChange, selected.spaceId, rect, null, true)
  }

  /**
   * Every space snaps into the cell it already sits in and is renamed for it (alignToCells). Spaces stay
   * where they are on the photos.
   */
  function onAlignAll() {
    if (!grid) return
    const { draft: next, moved, renamed, left } = alignToCells(draft, grid.grid)
    if (next === draft) {
      return setNote(
        left
          ? `${left} space${left === 1 ? '' : 's'} had no free cell nearby and stayed; the rest are already in their cells`
          : "Every space is already in its cell, with its cell's label",
      )
    }
    emitGrown(fitSchematic(next))
    const parts = [`Aligned ${moved} space${moved === 1 ? '' : 's'}`]
    if (renamed) parts.push(`renamed ${renamed}`)
    if (left) parts.push(`${left} had no free cell nearby and stayed`)
    setNote(parts.join('; '))
  }

  /** Esc clears the selection, except while typing in a field. */
  function onEditorKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    const tag = (e.target as HTMLElement).tagName
    if (e.key === 'Escape' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') onSelectSpace(null)
  }

  /**
   * + Space. With a grid, the new space goes in a cell and is named for it: the first free cell right
   * of the selected space in its row, or with nothing selected the first cell of the row below the last
   * one. Without a grid, next to the selected space's row as before.
   */
  function onAddSpace() {
    const g = grid?.grid
    if (g) {
      const sel = draft.spaces.find((s) => s.spaceId === selectedSpaceId)
      const active = draft.spaces.filter((s) => !s.retired)
      const rowOf = (s: DraftSpace) => cellAt(g, [s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2]).row
      const from = sel ? cellAt(g, [sel.rect.x + sel.rect.w / 2, sel.rect.y + sel.rect.h / 2]) : null
      let cell: Cell = from ? { row: from.row, col: from.col + 1 } : { row: Math.max(0, ...active.map(rowOf)) + (active.length ? 1 : 0), col: 0 }
      const digits = labelDigits(draft.spaces)
      for (let n = 0; n < 200 && cellTaken(g, draft.spaces, cell, cellLabel(cell, digits), undefined); n++) cell = { ...cell, col: cell.col + 1 }
      const added = addSpacesInCells(draft, g, [cell])
      if (added.spaces.length === 0) return setNote('No free cell to add a space in')
      emitGrown(added)
      onSelectSpace(added.spaces[0].spaceId)
      return setNote(`Added ${added.spaces[0].label}`)
    }
    const { draft: next, space, ...shift } = addSpace(draft, selectedSpaceId)
    emitGrown({ draft: proposeOutlines(next, [space.spaceId]), ...shift })
    onSelectSpace(space.spaceId)
    setNote(`Added ${space.label}`)
  }

  function onAddRow(start: ParsedLabel, count: number) {
    const { draft: next, spaces, ...shift } = addRow(draft, start, count)
    emitGrown({ draft: proposeOutlines(next, spaces.map((s) => s.spaceId)), ...shift })
    setRowOpen(false)
    const first = spaces[0].label
    const last = spaces[spaces.length - 1].label
    setNote(spaces.length === 1 ? `Added ${first}` : `Added ${first} to ${last}`)
  }

  function onDelete(space: DraftSpace) {
    onChange(deleteSpace(draft, space.spaceId))
    onSelectSpace(null)
    if (hoveredSpaceId === space.spaceId) onHoverSpace(null)
    setNote(`Deleted ${space.label.trim() || 'space'}`)
  }

  const selectedRect = selected && (preview?.spaceId === selected.spaceId ? preview.rect : selected.rect)
  // Handles keep the same size on screen whatever the zoom.
  const handle = Math.max(view.w, view.h) * 0.012
  const zoomPercent = Math.round((fit.w / view.w) * 100)
  const selectedIssues = selected ? issues.filter((i) => i.spaceIds.includes(selected.spaceId)) : []

  return (
    <section className="mapping-panel schematic-editor" aria-label="Schematic" onKeyDown={onEditorKeyDown}>
      <h2>Schematic</h2>
      <div className="schematic-toolbar">
        <button type="button" className="button" onClick={onAddSpace}>
          + Space
        </button>
        <button type="button" className="button" onClick={() => setRowOpen(true)} aria-expanded={rowOpen}>
          + Row
        </button>
        <span className="schematic-tools" role="group" aria-label="Drag on empty map to">
          <button type="button" className="button button--sm" aria-pressed={tool === 'pan'} onClick={() => setTool('pan')}>
            Pan
          </button>
          <button type="button" className="button button--sm" aria-pressed={tool === 'draw'} onClick={() => setTool('draw')}>
            Draw space
          </button>
        </span>
        <span className="schematic-tools" role="group" aria-label="Zoom">
          <button type="button" className="button button--sm" onClick={() => zoomAt(1 / ZOOM_STEP)} aria-label="Zoom out">
            −
          </button>
          <span className="hint schematic-zoom" aria-live="polite">
            {zoomPercent}%
          </span>
          <button type="button" className="button button--sm" onClick={() => zoomAt(ZOOM_STEP)} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="button button--sm" onClick={() => setCamera(null)} disabled={camera === null}>
            Fit
          </button>
        </span>
        <span className="hint">{summary}</span>
      </div>
      {grid && <GridBar controls={grid} selected={selected && !selected.retired ? selected : null} onAlignAll={onAlignAll} />}
      {rowOpen && (
        <RowDialog
          initialStart={nextRowStart(draft.spaces)}
          maxCount={maxRowCount(draft.schematic)}
          onAdd={onAddRow}
          onCancel={() => setRowOpen(false)}
        />
      )}
      {draft.spaces.length === 0 && <p className="hint">No spaces yet. Press + Space or + Row to start.</p>}

      <svg
        ref={svgRef}
        className={`schematic schematic--${tool}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Schematic editor"
        onKeyDown={onSvgKeyDown}
      >
        <rect className="schematic__outside" x={view.x} y={view.y} width={view.w} height={view.h} onPointerDown={startBackground} />
        <rect
          className="schematic__bg"
          data-testid="schematic-area"
          x={0}
          y={0}
          width={width}
          height={height}
          onPointerDown={startBackground}
        />
        {grid?.show && <GridLines grid={grid.grid} view={view} />}
        {draft.spaces.map((space) => {
          const id = space.spaceId
          const { x, y, w, h } = preview?.spaceId === id ? preview.rect : space.rect
          const dup = duplicates.has(id)
          const flagged = dup || issueIds.has(id)
          const text = describe(space, dup)
          const messages = issues.filter((i) => i.spaceIds.includes(id)).map((i) => i.message)
          const fs = Math.max(8, Math.min(w, h) * 0.2)
          const small = Math.max(6, Math.min(fs * 0.6, (w - 6) / 10))
          const cls = [
            'schematic-space',
            selectedSpaceId === id && 'schematic-space--selected',
            hoveredSpaceId === id && 'schematic-space--hovered',
            space.retired && 'schematic-space--retired',
            flagged && 'schematic-space--error',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <g
              key={id}
              className={cls}
              data-testid={`schematic-space-${id}`}
              role="button"
              tabIndex={0}
              aria-label={text}
              aria-pressed={selectedSpaceId === id}
              onPointerDown={(e) => startDrag(e, space, 'move')}
              onMouseEnter={() => onHoverSpace(id)}
              onMouseLeave={() => onHoverSpace(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectSpace(id)
                }
              }}
            >
              <title>{[text, ...messages].join('. ')}</title>
              <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) * 0.06} className="schematic-space__rect" />
              <text
                x={x + w / 2}
                y={y + h / 2}
                textAnchor="middle"
                dominantBaseline="central"
                className="schematic-space__label"
                fontSize={fs}
              >
                {space.label}
              </text>
              {space.type !== 'STANDARD' && <TypeBadge type={space.type} x={x} y={y} w={w} h={h} />}
              {space.retired && (
                <text x={x + w / 2} y={y + h * 0.8} textAnchor="middle" className="schematic-space__marker" fontSize={small}>
                  Retired
                </text>
              )}
              {dup && (
                <text x={x + w / 2} y={y + h * 0.8} textAnchor="middle" className="schematic-space__note" fontSize={small}>
                  {DUPLICATE_NOTE}
                </text>
              )}
              {flagged && !dup && (
                <text x={x + w - 4} y={y + 4 + fs * 0.8} textAnchor="end" className="schematic-space__note" fontSize={fs * 0.8}>
                  !
                </text>
              )}
            </g>
          )
        })}
        {selected && selectedRect && !selected.retired &&
          CORNERS.map((corner) => {
            const cx = selectedRect.x + (corner.endsWith('e') ? selectedRect.w : 0)
            const cy = selectedRect.y + (corner.startsWith('s') ? selectedRect.h : 0)
            return (
              <rect
                key={corner}
                className={`schematic-handle schematic-handle--${corner}`}
                data-testid={`schematic-handle-${corner}`}
                aria-hidden="true"
                x={cx - handle / 2}
                y={cy - handle / 2}
                width={handle}
                height={handle}
                onPointerDown={(e) => startDrag(e, selected, corner)}
              />
            )
          })}
        {drawCells?.map((cell) => {
          const r = cellRect(grid!.grid, cell)
          return (
            <rect
              key={`${cell.row}:${cell.col}`}
              className="schematic-drawbox"
              data-testid="schematic-drawcell"
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
            />
          )
        })}
        {drawBox && (
          <rect
            className="schematic-drawbox"
            data-testid="schematic-drawbox"
            x={drawBox.x}
            y={drawBox.y}
            width={drawBox.w}
            height={drawBox.h}
          />
        )}
      </svg>
      <p className="hint schematic-legend">
        Red dashed outline: needs fixing. Grey dashed: retired. ADA and EV spaces carry a badge.
      </p>
      <p className="hint" aria-live="polite">
        {note}
      </p>

      {selected ? (
        <div className="form schematic-side" role="group" aria-label="Selected space">
          <h3 className="schematic-side__title">Selected {selected.label.trim() || 'space'}</h3>
          {selected.retired ? (
            <>
              <p className="hint">Retired: its history is kept, and drivers stop seeing it after the next publish.</p>
              <button
                type="button"
                className="button"
                onClick={() => onChange(updateSpace(draft, selected.spaceId, { retired: false }))}
              >
                Restore space
              </button>
            </>
          ) : (
            <>
              <label>
                Label
                <input
                  value={selected.label}
                  onChange={(e) => onChange(updateSpace(draft, selected.spaceId, { label: e.target.value }))}
                  aria-invalid={duplicates.has(selected.spaceId) || undefined}
                  aria-describedby={duplicates.has(selected.spaceId) ? noteId : undefined}
                />
              </label>
              {duplicates.has(selected.spaceId) && (
                <p id={noteId} className="schematic-note--error">
                  {DUPLICATE_NOTE}
                </p>
              )}
              <label>
                Type
                <select
                  value={selected.type}
                  onChange={(e) => onChange(updateSpace(draft, selected.spaceId, { type: e.target.value as SpaceType }))}
                >
                  {TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button"
                // A proposal waiting for review would block publishing for a space nobody will outline.
                onClick={() =>
                  onChange(dropPendingProposals(updateSpace(draft, selected.spaceId, { retired: true }), [selected.spaceId]))
                }
              >
                Retire space
              </button>
            </>
          )}
          {canDeleteSpace(selected.spaceId, draft.basedOnVersion, publishedIds) && (
            <button type="button" className="button schematic-side__delete" onClick={() => onDelete(selected)}>
              Delete space
            </button>
          )}
          {selectedIssues.length > 0 && (
            <ul className="schematic-side__issues">
              {selectedIssues.map((i, n) => (
                <li key={`${i.code}-${n}`}>{i.message}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="hint">
          Select a space to edit its label and type. Drag to move it, drag a corner to resize it, or use the arrow
          keys (Shift for 10 units). Esc clears the selection. Drag past the map edge to make room: the map grows.
          With Draw space on, drag a box on empty map to add a space; it gets a proposed outline on the photo.
          Ctrl/Cmd + scroll zooms; drag empty map (or use the middle button) to pan.
        </p>
      )}
    </section>
  )
}

/** "ADA" or "EV" in a small filled tag at the space's top-left corner. */
function TypeBadge({ type, x, y, w, h }: { type: SpaceType; x: number; y: number; w: number; h: number }) {
  const fs = Math.max(7, Math.min(w, h) * 0.14)
  const bw = fs * (type.length * 0.75 + 0.8)
  const bh = fs * 1.4
  return (
    <g className="schematic-badge" aria-hidden="true">
      <rect x={x + 4} y={y + 4} width={bw} height={bh} rx={bh * 0.25} />
      <text x={x + 4 + bw / 2} y={y + 4 + bh / 2} textAnchor="middle" dominantBaseline="central" fontSize={fs}>
        {type}
      </text>
    </g>
  )
}

interface RowDialogProps {
  initialStart: string
  maxCount: number
  onAdd: (start: ParsedLabel, count: number) => void
  onCancel: () => void
}

/** + Row (US-07 #2): start label and count, then a line of evenly spaced spaces. */
function RowDialog({ initialStart, maxCount, onAdd, onCancel }: RowDialogProps) {
  const [start, setStart] = useState(initialStart)
  const [count, setCount] = useState('10')
  const [error, setError] = useState<string | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const parsed = parseLabel(start)
    if (!parsed) return setError('Enter a start label like B-01')
    const n = Number(count)
    if (!Number.isInteger(n) || n < 1 || n > maxCount) return setError(`Enter a number of spaces from 1 to ${maxCount}`)
    onAdd(parsed, n)
  }

  return (
    <form
      className="form schematic-dialog"
      role="dialog"
      aria-label="Add a row"
      noValidate
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <label>
        Start label
        <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="B-01" autoFocus />
      </label>
      <label>
        Number of spaces
        <input type="number" min={1} max={maxCount} value={count} onChange={(e) => setCount(e.target.value)} />
      </label>
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <div className="schematic-dialog__actions">
        <button type="submit" className="button button--primary">
          Add row
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Cell boundaries, and row letters / column numbers along the top and left of the view. Not clickable. */
function GridLines({ grid, view }: { grid: Grid; view: { x: number; y: number; w: number; h: number } }) {
  const { xs, ys, rows, cols } = gridInView(grid, view)
  const fs = Math.min(grid.cellH * 0.3, grid.cellW * 0.45, Math.max(view.w, view.h) * 0.018)
  return (
    <g className="schematic-grid" aria-hidden="true" data-testid="schematic-grid">
      {xs.map((x) => (
        <line key={`x${x}`} x1={x} x2={x} y1={view.y} y2={view.y + view.h} />
      ))}
      {ys.map((y) => (
        <line key={`y${y}`} x1={view.x} x2={view.x + view.w} y1={y} y2={y} />
      ))}
      {rows.map((row) => {
        const letter = rowLetter(row)
        return (
          letter && (
            <text key={`r${row}`} x={view.x + fs * 0.4} y={grid.y0 + (row + 0.5) * grid.cellH} fontSize={fs} dominantBaseline="central">
              {letter}
            </text>
          )
        )
      })}
      {cols
        .filter((col) => col >= 0)
        .map((col) => (
          <text key={`c${col}`} x={grid.x0 + (col + 0.5) * grid.cellW} y={view.y + fs * 0.9} fontSize={fs} textAnchor="middle">
            {col + 1}
          </text>
        ))}
    </g>
  )
}

const SIZE_FIELDS: { key: keyof GridSizes; label: string }[] = [
  { key: 'boxW', label: 'Space width' },
  { key: 'boxH', label: 'Space height' },
  { key: 'gapX', label: 'Gap across' },
  { key: 'gapY', label: 'Gap down' },
]

/** Snap and grid toggles, the grid's sizes (schematic units), Fit grid, and Align all. */
function GridBar({ controls, selected, onAlignAll }: { controls: GridControls; selected: DraftSpace | null; onAlignAll: () => void }) {
  const sizes = gridSizes(controls.grid)
  return (
    <div className="schematic-gridbar" role="group" aria-label="Grid">
      <label className="schematic-check">
        <input type="checkbox" checked={controls.snap} onChange={(e) => controls.setSnap(e.target.checked)} />
        Snap to grid
      </label>
      <label className="schematic-check">
        <input type="checkbox" checked={controls.show} onChange={(e) => controls.setShow(e.target.checked)} />
        Show grid
      </label>
      {SIZE_FIELDS.map(({ key, label }) => (
        <SizeField key={key} label={label} value={sizes[key]} min={key.startsWith('gap') ? 0 : MIN_SIDE} onCommit={(v) => controls.setSizes({ [key]: v })} />
      ))}
      <button
        type="button"
        className="button button--sm"
        onClick={() => controls.fitTo(selected ? { rect: selected.rect, label: selected.label } : null)}
        title={
          selected
            ? `Line the grid up with ${selected.label.trim() || 'the selected space'}: its cell and size`
            : "Fit the grid to all the spaces' labels"
        }
      >
        {selected ? `Fit grid to ${selected.label.trim() || 'selected'}` : 'Fit grid'}
      </button>
      <button
        type="button"
        className="button button--sm"
        onClick={onAlignAll}
        title="Snap every space into the cell it is in, at the grid's size, and name it for that cell"
      >
        Align all to grid
      </button>
    </div>
  )
}

/** A number field that applies its value on Enter or when it loses focus, so typing "45" doesn't apply "4" first. */
function SizeField({ label, value, min, onCommit }: { label: string; value: number; min: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const commit = () => {
    const v = Number(text)
    if (text !== null && Number.isFinite(v) && v >= min) onCommit(v)
    setText(null)
  }
  return (
    <label className="schematic-size">
      {label}
      <input
        type="number"
        min={min}
        step="any"
        value={text ?? String(value)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </label>
  )
}
