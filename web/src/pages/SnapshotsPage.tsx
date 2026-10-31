import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAdminLot } from '../admin/AdminLotContext'
import { api, errorMessage } from '../api/client'
import type { SnapshotOut } from '../api/lotsAdmin'
import type { LotDetail, ObservationOut, SnapshotDetail } from '../api/schemas'
import { StateIconSvg } from '../components/StateIcon'
import { dateTime } from '../lib/relativeTime'
import { POLL_MS, canRetry, isActive, modelName, processingTime, score, statusLabel } from '../lib/snapshots'
import { visualFor } from '../lib/status'
import { useFetch } from '../lib/useFetch'

function decodeHash(hash: string): string {
  const raw = hash.replace(/^#/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const rowId = (imageId: string) => `snapshot-${imageId}`
const NO_PATCHES: Record<string, SnapshotOut> = {}

/** US-06: every uploaded photo for the picked lot, its job state, Retry, and per-space detail. */
export function SnapshotsPage() {
  const { lotId, lots } = useAdminLot()
  const nameOf = (id: string) => lots?.find((l) => l.lotId === id)?.name ?? id
  const lotName = nameOf(lotId)
  const list = useFetch<SnapshotOut[] | null>(
    () => (lotId ? api.get<SnapshotOut[]>(`/admin/snapshots?lotId=${encodeURIComponent(lotId)}`) : Promise.resolve(null)),
    `snapshots:${lotId}`,
  )
  // Labels for the detail table; unpublished lots are not public, so fall back to space ids.
  const lotDetail = useFetch<LotDetail | null>(
    () => (lotId ? api.get<LotDetail>(`/lots/${encodeURIComponent(lotId)}`).catch(() => null) : Promise.resolve(null)),
    `snapshots-lot:${lotId}`,
  )
  const labelById = useMemo(
    () => new Map((lotDetail.data?.layout.spaces ?? []).map((s) => [s.spaceId, s.label])),
    [lotDetail.data],
  )

  // Rows replaced by a Retry response, until the next list load replaces them all.
  const [patched, setPatched] = useState<{ for: SnapshotOut[] | null; rows: Record<string, SnapshotOut> }>({
    for: null,
    rows: {},
  })
  const patches = patched.for === list.data ? patched.rows : NO_PATCHES
  const rows = useMemo(() => (list.data ?? []).map((r) => patches[r.imageId] ?? r), [list.data, patches])

  const [retrying, setRetrying] = useState<string | null>(null)
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({})

  const { hash } = useLocation()
  const anchorId = decodeHash(hash)
  const [selectedId, setSelectedId] = useState<string | null>(anchorId || null)

  // Poll while any job can still change on its own (US-06 #3: QUEUED -> COMPLETE or FAILED).
  const polling = rows.some(isActive)
  const { reload } = list
  useEffect(() => {
    if (!polling) return
    const timer = window.setInterval(reload, POLL_MS)
    return () => window.clearInterval(timer)
  }, [polling, reload])

  // `/admin/snapshots#<imageId>` (the duplicate-upload link): scroll to that row once it is listed.
  const scrolledTo = useRef<string | null>(null)
  useEffect(() => {
    if (!anchorId || scrolledTo.current === anchorId || !rows.some((r) => r.imageId === anchorId)) return
    scrolledTo.current = anchorId
    document.getElementById(rowId(anchorId))?.scrollIntoView?.({ block: 'center' })
  }, [anchorId, rows])

  async function retry(imageId: string) {
    setRetrying(imageId)
    setRetryErrors((errs) => {
      const next = { ...errs }
      delete next[imageId]
      return next
    })
    try {
      const updated = await api.post<SnapshotOut>(`/admin/snapshots/${encodeURIComponent(imageId)}/retry`)
      setPatched({ for: list.data, rows: { ...patches, [imageId]: updated } })
    } catch (e) {
      setRetryErrors((errs) => ({ ...errs, [imageId]: errorMessage(e) }))
    } finally {
      setRetrying(null)
    }
  }

  const selectedRow = rows.find((r) => r.imageId === selectedId)

  return (
    <main className="page snapshots-page">
      <Link to="/admin" className="back-link">
        ← Admin
      </Link>
      <div className="page__head">
        <h1>
          Snapshots {lotName && <span className="mapping-head__part">{lotName}</span>}
        </h1>
        <button type="button" className="button" onClick={reload} disabled={!lotId || list.loading}>
          Refresh
        </button>
      </div>
      {polling && (
        <p className="hint" role="status">
          Checking for updates every {POLL_MS / 1000} s while jobs are running.
        </p>
      )}

      {!lotId && lots && (
        <p className="notice">
          No lots yet. <Link to="/admin/lots/new">Create a lot</Link> to start uploading photos.
        </p>
      )}
      {list.error && (
        <p className="notice notice--error" role="alert">
          {list.error}
        </p>
      )}
      {list.data && rows.length === 0 && (
        <p className="notice">
          No photos uploaded for this lot yet. <Link to="/admin/upload">Upload a photo</Link>.
        </p>
      )}

      {rows.length > 0 && (
        <div className="snapshots-table-wrap">
          <table className="snapshots-table">
            <thead>
              <tr>
                <th scope="col">Captured</th>
                <th scope="col">View</th>
                <th scope="col">State</th>
                <th scope="col">Time</th>
                <th scope="col">Model</th>
                <th scope="col">Error</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const classes = [
                  'snapshot-row',
                  s.imageId === anchorId ? 'snapshot-row--highlight' : '',
                  s.imageId === selectedId ? 'snapshot-row--selected' : '',
                ]
                return (
                  <tr
                    key={s.imageId}
                    id={rowId(s.imageId)}
                    className={classes.filter(Boolean).join(' ')}
                    data-testid={`snapshot-${s.imageId}`}
                    onClick={() => setSelectedId(s.imageId)}
                  >
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        aria-expanded={s.imageId === selectedId}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedId(s.imageId)
                        }}
                      >
                        {dateTime(s.captureTime)}
                      </button>
                    </td>
                    <td>
                      {s.viewId}
                      {s.rescoreOf && s.layoutVersion != null && (
                        <span className="muted snapshot-row__rescore"> · Re-scored for layout v{s.layoutVersion}</span>
                      )}
                    </td>
                    <td>
                      <span className={`job-status job-status--${s.jobStatus.toLowerCase()}`}>
                        {statusLabel(s.jobStatus)}
                      </span>
                    </td>
                    <td>{processingTime(s.processingMs)}</td>
                    <td title={s.modelVersion ?? undefined}>{modelName(s.modelVersion)}</td>
                    <td>
                      {s.error ?? '-'}
                      {retryErrors[s.imageId] && (
                        <span className="snapshot-row__retry-error" role="alert">
                          {retryErrors[s.imageId]}
                        </span>
                      )}
                    </td>
                    <td>
                      {canRetry(s) && (
                        <button
                          type="button"
                          className="button"
                          disabled={retrying === s.imageId}
                          onClick={(e) => {
                            e.stopPropagation()
                            void retry(s.imageId)
                          }}
                        >
                          {retrying === s.imageId ? 'Retrying…' : 'Retry'}
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

      {selectedId && (
        <SnapshotDetailPanel
          imageId={selectedId}
          lotId={lotId}
          nameOf={nameOf}
          // Refetch the detail whenever the listed job state moves on.
          version={selectedRow ? `${selectedRow.jobStatus}:${selectedRow.attempts}` : ''}
          labelById={labelById}
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  )
}

function SnapshotDetailPanel({
  imageId,
  lotId,
  nameOf,
  version,
  labelById,
  onClose,
}: {
  imageId: string
  lotId: string
  nameOf: (lotId: string) => string
  version: string
  labelById: Map<string, string>
  onClose: () => void
}) {
  const detail = useFetch(
    () => api.get<SnapshotDetail>(`/admin/snapshots/${encodeURIComponent(imageId)}`),
    `snapshot-detail:${imageId}:${version}`,
  )
  // A `#<imageId>` link can name another lot's photo; the detail route is not lot-scoped.
  const otherLot = detail.data && detail.data.lotId !== lotId ? detail.data.lotId : null
  const d = otherLot ? null : detail.data
  const label = (o: ObservationOut) => labelById.get(o.spaceId) ?? o.spaceId
  const observations = d
    ? [...d.observations].sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }))
    : []

  return (
    <section className="snapshot-detail" aria-labelledby="snapshot-detail-title">
      <div className="snapshot-detail__head">
        <h2 id="snapshot-detail-title">Snapshot detail</h2>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {detail.loading && !detail.data && <p className="muted">Loading…</p>}
      {otherLot && (
        <p className="notice">
          This photo belongs to {nameOf(otherLot)}, not {nameOf(lotId)}. Pick that lot to see it.
        </p>
      )}
      {detail.error && (
        <p className="notice notice--error" role="alert">
          {detail.error}
        </p>
      )}
      {d && (
        <>
          <p className="snapshot-detail__layout">
            {d.layoutVersion != null ? `Processed with layout v${d.layoutVersion}` : 'Not processed yet'}
            {d.rescoreOf && ' (the same photo re-scored after publishing)'}
          </p>
          <dl className="snapshot-detail__facts">
            <dt>Captured</dt>
            <dd>{dateTime(d.captureTime)}</dd>
            <dt>View</dt>
            <dd>{d.viewId}</dd>
            <dt>State</dt>
            <dd>{statusLabel(d.jobStatus)}</dd>
            <dt>Attempts</dt>
            <dd>{d.attempts}</dd>
            <dt>Model</dt>
            <dd className="snapshot-detail__model">{d.modelVersion ?? '-'}</dd>
            {d.error && (
              <>
                <dt>Error</dt>
                <dd>{d.error}</dd>
              </>
            )}
          </dl>
          <p>
            <Link to={`/admin/snapshots/${encodeURIComponent(imageId)}/photo`}>View photo with outlines</Link>
          </p>
          {observations.length === 0 ? (
            <p className="muted">
              {d.jobStatus === 'COMPLETE' ? 'No space results in this photo.' : 'No space results yet.'}
            </p>
          ) : (
            <div className="snapshots-table-wrap">
              <table className="snapshots-table snapshot-detail__spaces">
                <caption className="visually-hidden">Per-space results</caption>
                <thead>
                  <tr>
                    <th scope="col">Space</th>
                    <th scope="col">State</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Car overlap</th>
                    <th scope="col">In frame</th>
                  </tr>
                </thead>
                <tbody>
                  {observations.map((o) => {
                    const v = visualFor(o.state)
                    return (
                      <tr key={o.spaceId}>
                        <th scope="row">{label(o)}</th>
                        <td>
                          <span className="snapshot-detail__state">
                            <StateIconSvg icon={v.icon} className={v.className} />
                            {v.label}
                          </span>
                        </td>
                        <td>{score(o.acpdsScore)}</td>
                        <td>{score(o.carOverlap)}</td>
                        <td>{o.inFrame ? 'Yes' : 'No'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
