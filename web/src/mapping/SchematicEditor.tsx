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
import { addRow, addSpace, canDeleteSpace, deleteSpace, updateSpace } from './schematic/edits'
import { CORNERS, maxRowCount, moveRect, resizeRect, sameRect, type Corner } from './schematic/geometry'
import { duplicateLabelIds, nextRowStart, parseLabel, type ParsedLabel } from './schematic/labels'
import type { DraftLayout, DraftRect, DraftSpace, Issue, MappingSelection, SpaceType } from './types'

export interface SchematicEditorProps extends MappingSelection {
  draft: DraftLayout
  onChange: (next: DraftLayout) => void
  issues: Issue[] // from the last validation; affected spaces are outlined in red
  /**
   * Optional: ids of spaces in any published version, which can only be retired. Without it, the
   * spaces the draft had when the editor first showed this lot and version count as published.
   */
  publishedSpaceIds?: ReadonlySet<string>
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
  selectedSpaceId,
  onSelectSpace,
  hoveredSpaceId,
  onHoverSpace,
}: SchematicEditorProps) {
  const { width, height } = draft.schematic
  const svgRef = useRef<SVGSVGElement>(null)
  const [preview, setPreview] = useState<{ spaceId: string; rect: DraftRect } | null>(null)
  const [rowOpen, setRowOpen] = useState(false)
  const [note, setNote] = useState('')
  const noteId = useId()

  // A drag listens on window; it reads the latest draft and callback when the pointer is released.
  const latest = useRef({ draft, onChange })
  useEffect(() => {
    latest.current = { draft, onChange }
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
    return box && box.width > 0 && box.height > 0 ? Math.max(width / box.width, height / box.height) : 1
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
    const bounds = draft.schematic
    let moved = false
    const rectAt = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * scale
      const dy = (ev.clientY - y0) * scale
      return mode === 'move' ? moveRect(origin, dx, dy, bounds) : resizeRect(origin, mode, dx, dy, bounds)
    }
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return
      moved = true
      setPreview({ spaceId: space.spaceId, rect: rectAt(ev) })
    }
    const onUp = (ev: PointerEvent) => {
      stop()
      if (!moved) return
      const rect = rectAt(ev)
      const { draft: current, onChange: emit } = latest.current
      const now = current.spaces.find((s) => s.spaceId === space.spaceId)
      if (now && !sameRect(rect, now.rect)) emit(updateSpace(current, space.spaceId, { rect }))
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

  /** Arrow keys move the selected space by 1 unit, 10 with Shift. */
  function onSvgKeyDown(e: ReactKeyboardEvent<SVGSVGElement>) {
    const step = ARROWS[e.key]
    if (!step || !selected || selected.retired) return
    e.preventDefault()
    const n = e.shiftKey ? 10 : 1
    const rect = moveRect(selected.rect, step[0] * n, step[1] * n, draft.schematic)
    if (!sameRect(rect, selected.rect)) onChange(updateSpace(draft, selected.spaceId, { rect }))
  }

  /** Esc clears the selection, except while typing in a field. */
  function onEditorKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    const tag = (e.target as HTMLElement).tagName
    if (e.key === 'Escape' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') onSelectSpace(null)
  }

  function onAddSpace() {
    const { draft: next, space } = addSpace(draft, selectedSpaceId)
    onChange(next)
    onSelectSpace(space.spaceId)
    setNote(`Added ${space.label}`)
  }

  function onAddRow(start: ParsedLabel, count: number) {
    const { draft: next, spaces } = addRow(draft, start, count)
    onChange(next)
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
  const handle = Math.max(8, Math.min(width, height) * 0.016)
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
        <span className="hint">{summary}</span>
      </div>
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
        className="schematic"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Schematic editor"
        onKeyDown={onSvgKeyDown}
      >
        <rect className="schematic__bg" x={0} y={0} width={width} height={height} onPointerDown={() => onSelectSpace(null)} />
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
                onClick={() => onChange(updateSpace(draft, selected.spaceId, { retired: true }))}
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
          keys (Shift for 10 units). Esc clears the selection.
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
