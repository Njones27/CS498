import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAdminLot } from '../admin/AdminLotContext'
import { api, errorMessage } from '../api/client'
import type { OverrideCreate, OverrideOut, OverrideState } from '../api/overrides'
import type { LotDetail, LotStatusOut, SpaceStatusOut } from '../api/schemas'
import { AdminBadgeIcon, LotMapSvg } from '../components/LotMapSvg'
import { StateIconSvg } from '../components/StateIcon'
import { STATUS_LABEL, compactLabels, rowOf } from '../lib/closures'
import { OVERRIDE_STATES, overrideStateLabel, overrideWindow } from '../lib/overrides'
import { dateTime } from '../lib/relativeTime'
import { STATE_ORDER, visualFor } from '../lib/status'
import { parseLocalDateTime } from '../lib/uploadValidation'
import { useFetch } from '../lib/useFetch'

const FUTURE_MESSAGE = 'Choose an "until" time in the future'

const NOT_PUBLISHED = 'Publish the lot before setting space states'

const NOTE_MAX = 200

/** Admin state overrides: set spaces Free or Occupied over what the cameras report. */
export function OverridesPage() {
  const { lotId: pickedId, lots, error: lotsError } = useAdminLot()
  const picked = lots?.find((l) => l.lotId === pickedId)
  // The lot's layout and status come from the public routes, which only serve published lots.
  const lotId = picked?.published ? picked.lotId : ''
  const base = `/lots/${encodeURIComponent(lotId)}`
  const adminBase = `/admin/lots/${encodeURIComponent(lotId)}/overrides`
  const detail = useFetch<LotDetail | null>(
    () => (lotId ? api.get<LotDetail>(base) : Promise.resolve(null)),
    `overrides-detail:${lotId}`,
  )
  const status = useFetch<LotStatusOut | null>(
    () => (lotId ? api.get<LotStatusOut>(`${base}/status`) : Promise.resolve(null)),
    `overrides-status:${lotId}`,
  )
  const overrides = useFetch<OverrideOut[] | null>(
    () => (lotId ? api.get<OverrideOut[]>(adminBase) : Promise.resolve(null)),
    `overrides-list:${lotId}`,
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
    const s = statusById.get(spaceId)
    const text = `${label}: ${visualFor(s?.state ?? 'UNKNOWN').label}` // selection is announced via aria-pressed
    return s?.source === 'admin' ? `${text}, set by admin` : text
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
    overrides.reload()
    status.reload()
  }

  async function endNow(o: OverrideOut) {
    setActionError(null)
    setEnding(o.overrideId)
    try {
      await api.delete<OverrideOut>(`${adminBase}/${encodeURIComponent(o.overrideId)}`)
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      // Also after a 409 already_ended, so a stale row refreshes.
      setEnding(null)
      overrides.reload()
      status.reload()
    }
  }

  const loadError = (lots ? null : lotsError) ?? detail.error ?? status.error ?? overrides.error

  return (
    <main className="page">
      <Link to="/admin" className="back-link">
        ← Admin
      </Link>
      <h1>Set space state{picked ? `: ${picked.name}` : ''}</h1>
      <p className="hint">
        Drivers see the state you set instead of what the cameras report, until you end it or the
        &ldquo;until&rdquo; time passes. A closure still wins.
      </p>
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
              Set state…
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
          <OverridesLegend />
        </section>
      )}
      {dialogOpen && (
        <SetStateDialog
          spacesText={`${labelsFor(selectedIds)} (${selectedIds.length} selected)`}
          onCancel={closeDialog}
          onSubmit={(body) => api.post<OverrideOut>(adminBase, { ...body, spaceIds: selectedIds })}
          onCreated={onCreated}
        />
      )}
      <section className="closures-list" aria-label="Overrides">
        <h2>Overrides</h2>
        {actionError && (
          <p className="notice notice--error" role="alert">
            {actionError}
          </p>
        )}
        {overrides.data && overrides.data.length === 0 && <p className="muted">No overrides yet.</p>}
        {overrides.data && overrides.data.length > 0 && (
          <div className="closures-table-wrap">
            <table className="closures-table">
              <thead>
                <tr>
                  <th scope="col">Spaces</th>
                  <th scope="col">State</th>
                  <th scope="col">Window</th>
                  <th scope="col">Note</th>
                  <th scope="col">Created</th>
                  <th scope="col">Status</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {overrides.data.map((o) => {
                  const labels = labelsFor(o.spaceIds)
                  return (
                    <tr key={o.overrideId} data-testid={`override-${o.overrideId}`}>
                      <td>{labels}</td>
                      <td>{overrideStateLabel(o.state)}</td>
                      <td>{overrideWindow(o)}</td>
                      <td>{o.note || <span className="muted">None</span>}</td>
                      <td>
                        {o.createdBy}
                        <br />
                        <span className="muted">{dateTime(o.createdAt)}</span>
                      </td>
                      <td>
                        <span className={`closure-status closure-status--${o.status.toLowerCase()}`}>
                          {STATUS_LABEL[o.status]}
                        </span>
                      </td>
                      <td>
                        {o.status !== 'ENDED' && (
                          <button
                            type="button"
                            aria-label={`End override for ${labels}`}
                            className="button"
                            onClick={() => void endNow(o)}
                            disabled={ending === o.overrideId}
                          >
                            End
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
  onSubmit: (body: Omit<OverrideCreate, 'spaceIds'>) => Promise<unknown>
  onCreated: () => void
}

/** State, optional "until" time and a short note for the selected spaces; starts now. */
function SetStateDialog({ spacesText, onCancel, onSubmit, onCreated }: DialogProps) {
  const [state, setState] = useState<OverrideState | ''>('')
  const [until, setUntil] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstField.current?.focus()
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const now = new Date()
    const end = parseLocalDateTime(until)
    if (!state) return setError('Choose Free or Occupied')
    if (until && (!end || end.getTime() <= now.getTime())) return setError(FUTURE_MESSAGE)
    setError(null)
    setBusy(true)
    try {
      await onSubmit({
        state,
        note: note.trim(),
        startsAt: now.toISOString(),
        endsAt: end ? end.toISOString() : null,
      })
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
        aria-labelledby="set-state-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onCancel()
        }}
      >
        <h2 id="set-state-title">Set state</h2>
        <form className="form" onSubmit={submit} noValidate>
          <p className="modal__spaces">Spaces: {spacesText}</p>
          <fieldset className="override-states">
            <legend>Show drivers</legend>
            {OVERRIDE_STATES.map((s, i) => (
              <label key={s.value} className="override-states__option">
                <input
                  ref={i === 0 ? firstField : undefined}
                  type="radio"
                  name="override-state"
                  value={s.value}
                  checked={state === s.value}
                  onChange={() => setState(s.value)}
                />
                {s.label}
              </label>
            ))}
          </fieldset>
          <label>
            Until <span className="muted">(optional; leave empty until you end it)</span>
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <label>
            Note <span className="muted">(optional)</span>
            <input type="text" value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
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
              Set state
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function OverridesLegend() {
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
          <AdminBadgeIcon />
          Set by admin
        </li>
        <li>
          <StateIconSvg icon="empty" className="space--free space--selected" />
          Thick outline: selected
        </li>
      </ul>
    </section>
  )
}
