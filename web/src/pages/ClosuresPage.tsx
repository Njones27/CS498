import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAdminLot } from '../admin/AdminLotContext'
import { api, errorMessage } from '../api/client'
import type { ClosureCreate, ClosureOut, ClosureReason } from '../api/closures'
import type { LotDetail, LotStatusOut, SpaceStatusOut } from '../api/schemas'
import { LotMapSvg } from '../components/LotMapSvg'
import { StateIconSvg } from '../components/StateIcon'
import { REASONS, STATUS_LABEL, closureWindow, compactLabels, reasonLabel, rowOf } from '../lib/closures'
import { dateTime, toDateTimeLocal } from '../lib/relativeTime'
import { STATE_ORDER, visualFor } from '../lib/status'
import { parseLocalDateTime } from '../lib/uploadValidation'
import { useFetch } from '../lib/useFetch'

const WINDOW_MESSAGE = 'End time must be after start time'

const NOT_PUBLISHED = 'Publish the lot before closing spaces'

/** US-10: close spaces for construction, events, maintenance or reservations. */
export function ClosuresPage() {
  const { lotId: pickedId, lots, error: lotsError } = useAdminLot()
  const picked = lots?.find((l) => l.lotId === pickedId)
  // The lot's layout and status come from the public routes, which only serve published lots.
  const lotId = picked?.published ? picked.lotId : ''
  const base = `/lots/${encodeURIComponent(lotId)}`
  const adminBase = `/admin/lots/${encodeURIComponent(lotId)}/closures`
  const detail = useFetch<LotDetail | null>(
    () => (lotId ? api.get<LotDetail>(base) : Promise.resolve(null)),
    `closures-detail:${lotId}`,
  )
  const status = useFetch<LotStatusOut | null>(
    () => (lotId ? api.get<LotStatusOut>(`${base}/status`) : Promise.resolve(null)),
    `closures-status:${lotId}`,
  )
  const closures = useFetch<ClosureOut[] | null>(
    () => (lotId ? api.get<ClosureOut[]>(adminBase) : Promise.resolve(null)),
    `closures-list:${lotId}`,
  )

  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [ending, setEnding] = useState<string | null>(null)

  const layout = detail.data?.layout
  const spaces = useMemo(() => layout?.spaces ?? [], [layout])
  const labelById = useMemo(() => new Map(spaces.map((s) => [s.spaceId, s.label])), [spaces])
  const orderById = useMemo(() => new Map(spaces.map((s, i) => [s.spaceId, i])), [spaces])
  const rows = useMemo(() => {
    const seen: string[] = []
    for (const s of spaces) {
      const row = rowOf(s.label)
      if (row && !seen.includes(row)) seen.push(row)
    }
    return seen
  }, [spaces])
  const statusById = useMemo(() => {
    const m = new Map<string, SpaceStatusOut>()
    status.data?.spaces.forEach((s) => m.set(s.spaceId, s))
    return m
  }, [status.data])

  // Selected ids in layout order, so labels compact into ranges.
  const selectedIds = spaces.filter((s) => selected.has(s.spaceId)).map((s) => s.spaceId)
  const labelsFor = (ids: string[]) =>
    compactLabels(
      [...ids]
        .sort((a, b) => (orderById.get(a) ?? Infinity) - (orderById.get(b) ?? Infinity))
        .map((id) => labelById.get(id) ?? id),
    )

  function describe(spaceId: string): string {
    const label = labelById.get(spaceId) ?? spaceId
    const state = statusById.get(spaceId)?.state ?? 'UNKNOWN'
    return `${label}: ${visualFor(state).label}` // selection is announced via aria-pressed
  }

  function toggle(spaceId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(spaceId)) next.delete(spaceId)
      else next.add(spaceId)
      return next
    })
  }

  function selectRow(row: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      spaces.filter((s) => rowOf(s.label) === row).forEach((s) => next.add(s.spaceId))
      return next
    })
  }

  function closeDialog() {
    setDialogOpen(false)
    openButton.current?.focus()
  }

  function onCreated() {
    closeDialog()
    setSelected(new Set())
    closures.reload()
    status.reload()
  }

  async function endNow(c: ClosureOut) {
    setActionError(null)
    setEnding(c.closureId)
    try {
      await api.delete<ClosureOut>(`${adminBase}/${encodeURIComponent(c.closureId)}`)
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      // Also after a 409 already_ended, so a stale row refreshes.
      setEnding(null)
      closures.reload()
      status.reload()
    }
  }

  const loadError = (lots ? null : lotsError) ?? detail.error ?? status.error ?? closures.error

  return (
    <main className="page">
      <Link to="/admin" className="back-link">
        ← Admin
      </Link>
      <h1>Closures{picked ? `: ${picked.name}` : ''}</h1>
      {lots?.length === 0 && <p>No lots yet</p>}
      {picked && !picked.published && (
        <p className="notice">
          {NOT_PUBLISHED}. <Link to={`/admin/lots/${encodeURIComponent(picked.lotId)}/map`}>Open the map editor</Link>
        </p>
      )}
      {loadError && (
        <p className="notice notice--error" role="alert">
          {loadError}
        </p>
      )}
      {layout && (
        <section aria-label="Select spaces">
          <div className="closures-toolbar">
            {rows.map((row) => (
              <button key={row} type="button" className="button" onClick={() => selectRow(row)}>
                Row {row}
              </button>
            ))}
            <button type="button" className="button button--ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
              Clear selection
            </button>
            <span className="closures-toolbar__count" aria-live="polite">
              {selectedIds.length} selected
            </span>
            <button
              ref={openButton}
              type="button"
              className="button button--primary"
              onClick={() => setDialogOpen(true)}
              disabled={selectedIds.length === 0}
            >
              Close spaces…
            </button>
          </div>
          <div className="map-wrap">
            <LotMapSvg
              layout={layout}
              statusById={statusById}
              selectedId={null}
              onSelect={() => {}}
              describe={describe}
              selectedIds={selected}
              onToggle={toggle}
            />
          </div>
          <ClosuresLegend />
        </section>
      )}
      {dialogOpen && (
        <CloseSpacesDialog
          spacesText={`${labelsFor(selectedIds)} (${selectedIds.length} selected)`}
          onCancel={closeDialog}
          onSubmit={(body) => api.post<ClosureOut>(adminBase, { ...body, spaceIds: selectedIds })}
          onCreated={onCreated}
        />
      )}
      <section className="closures-list" aria-label="Closures">
        <h2>Closures</h2>
        {actionError && (
          <p className="notice notice--error" role="alert">
            {actionError}
          </p>
        )}
        {closures.data && closures.data.length === 0 && <p className="muted">No closures yet.</p>}
        {closures.data && closures.data.length > 0 && (
          <div className="closures-table-wrap">
            <table className="closures-table">
              <thead>
                <tr>
                  <th scope="col">Spaces</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Window</th>
                  <th scope="col">Created</th>
                  <th scope="col">Status</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {closures.data.map((c) => {
                  const labels = labelsFor(c.spaceIds)
                  return (
                    <tr key={c.closureId} data-testid={`closure-${c.closureId}`}>
                      <td>{labels}</td>
                      <td>{reasonLabel(c.reason)}</td>
                      <td>{closureWindow(c)}</td>
                      <td>
                        {c.createdBy}
                        <br />
                        <span className="muted">{dateTime(c.createdAt)}</span>
                      </td>
                      <td>
                        <span className={`closure-status closure-status--${c.status.toLowerCase()}`}>
                          {STATUS_LABEL[c.status]}
                        </span>
                      </td>
                      <td>
                        {c.status !== 'ENDED' && (
                          <button
                            type="button"
                            aria-label={`End closure for ${labels}`}
                            className="button"
                            onClick={() => void endNow(c)}
                            disabled={ending === c.closureId}
                          >
                            End now
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

interface DialogProps {
  spacesText: string
  onCancel: () => void
  onSubmit: (body: Omit<ClosureCreate, 'spaceIds'>) => Promise<unknown>
  onCreated: () => void
}

/** Sketch 7: reason and window for the selected spaces. */
function CloseSpacesDialog({ spacesText, onCancel, onSubmit, onCreated }: DialogProps) {
  const [reason, setReason] = useState<ClosureReason | ''>('')
  const [starts, setStarts] = useState(() => toDateTimeLocal(new Date()).slice(0, 16))
  const [ends, setEnds] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const firstField = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    firstField.current?.focus()
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const start = parseLocalDateTime(starts)
    const end = parseLocalDateTime(ends)
    if (!reason) return setError('Choose a reason')
    if (!start) return setError('Choose a start time')
    if (ends && (!end || end.getTime() <= start.getTime())) return setError(WINDOW_MESSAGE)
    setError(null)
    setBusy(true)
    try {
      await onSubmit({ reason, startsAt: start.toISOString(), endsAt: end ? end.toISOString() : null })
      onCreated()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-spaces-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onCancel()
        }}
      >
        <h2 id="close-spaces-title">Close spaces</h2>
        <form className="form" onSubmit={submit} noValidate>
          <p className="modal__spaces">Spaces: {spacesText}</p>
          <label>
            Reason
            <select ref={firstField} value={reason} onChange={(e) => setReason(e.target.value as ClosureReason | '')}>
              <option value="">Choose a reason</option>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Starts
            <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
          </label>
          <label>
            Ends <span className="muted">(optional; leave empty until further notice)</span>
            <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
          </label>
          {error && (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          )}
          <div className="modal__actions">
            <button type="button" className="button button--ghost" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="button button--primary" disabled={busy}>
              Close spaces
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ClosuresLegend() {
  return (
    <section className="legend" aria-label="Legend">
      <h2>Legend</h2>
      <ul>
        {STATE_ORDER.map((s) => {
          const v = visualFor(s)
          return (
            <li key={s}>
              <StateIconSvg icon={v.icon} className={v.className} />
              {v.label}
            </li>
          )
        })}
        <li>
          <StateIconSvg icon="empty" className="space--free space--selected" />
          Thick outline: selected
        </li>
      </ul>
    </section>
  )
}
