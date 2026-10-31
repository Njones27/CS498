import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { LotDetail, LotStatusOut, SpaceStatusOut } from '../api/schemas'
import { AdminBadgeIcon, LotMapSvg } from '../components/LotMapSvg'
import { StateIconSvg } from '../components/StateIcon'
import { setByAdminText } from '../lib/overrides'
import { dateTime, minutesAgo } from '../lib/relativeTime'
import { STATE_ORDER, visualFor } from '../lib/status'
import { useFetch } from '../lib/useFetch'

/** US-01 / US-02: schematic map of a lot with every space's state and data age. */
export function LotMapPage() {
  const { lotId = '' } = useParams()
  const path = `/lots/${encodeURIComponent(lotId)}`
  const detail = useFetch(() => api.get<LotDetail>(path), path)
  const status = useFetch(() => api.get<LotStatusOut>(`${path}/status`), `${path}/status`)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Refetch the layout once per new layoutVersion reported by /status.
  const requestedVersion = useRef<number | null>(null)
  const layoutVersion = detail.data?.layout.version
  const statusVersion = status.data?.layoutVersion
  const reloadDetail = detail.reload
  useEffect(() => {
    if (layoutVersion === undefined || statusVersion === undefined) return
    if (statusVersion !== layoutVersion && requestedVersion.current !== statusVersion) {
      requestedVersion.current = statusVersion
      reloadDetail()
    }
  }, [layoutVersion, statusVersion, reloadDetail])

  const statusById = useMemo(() => {
    const m = new Map<string, SpaceStatusOut>()
    status.data?.spaces.forEach((s) => m.set(s.spaceId, s))
    return m
  }, [status.data])

  const labelById = useMemo(() => {
    const m = new Map<string, string>()
    detail.data?.layout.spaces.forEach((s) => m.set(s.spaceId, s.label))
    return m
  }, [detail.data])

  function describe(spaceId: string): string {
    const label = labelById.get(spaceId) ?? spaceId
    const s = statusById.get(spaceId)
    if (!s) return `${label}: Unknown, no observation`
    if (s.source === 'admin') {
      // The admin's state replaces the camera reading, so its age does not apply.
      const note = s.override?.note ? `. Note: ${s.override.note}` : ''
      return `${label}: ${visualFor(s.state).label}. ${setByAdminText(s.override)}${note}`
    }
    const parts = [`${label}: ${visualFor(s.state).label}`]
    parts.push(s.observedAt ? `observed ${dateTime(s.observedAt)}` : 'no observation')
    if (s.stale) parts.push('out of date')
    if (s.closure) parts.push(`closed for ${s.closure.reason.toLowerCase()}`)
    return parts.join(', ')
  }

  const refresh = () => {
    status.reload()
  }
  const error = detail.error ?? status.error
  const st = status.data

  return (
    <main className="page">
      <Link to="/" className="back-link">
        ← All lots
      </Link>
      <div className="page__head">
        <h1>{detail.data?.lot.name ?? 'Lot'}</h1>
        <button type="button" className="button" onClick={refresh} disabled={status.loading}>
          Refresh
        </button>
      </div>
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {st && <SummaryBar status={st} />}
      {st?.isStale && (
        <p className="notice notice--warn" role="status">
          Some spaces are out of date. Check each space for its age.
        </p>
      )}
      {st?.processing && (
        <p className="notice" role="status">
          Processing new photo
        </p>
      )}
      {detail.data && (
        <div className="map-wrap">
          <LotMapSvg
            layout={detail.data.layout}
            statusById={statusById}
            selectedId={selectedId}
            onSelect={setSelectedId}
            describe={describe}
          />
          {selectedId && (
            <div className="popover" role="status" aria-live="polite" data-testid="space-popover">
              {describe(selectedId)}
              <button type="button" className="popover__close" aria-label="Close details" onClick={() => setSelectedId(null)}>
                ×
              </button>
            </div>
          )}
        </div>
      )}
      {(detail.loading || status.loading) && !detail.data && <p>Loading…</p>}
      <Legend />
    </main>
  )
}

function SummaryBar({ status }: { status: LotStatusOut }) {
  const counts: Record<string, number> = {
    FREE: status.counts.free,
    OCCUPIED: status.counts.occupied,
    UNKNOWN: status.counts.unknown,
    CLOSED: status.counts.closed,
  }
  return (
    <section className="summary" aria-label="Summary">
      <ul className="summary__counts">
        {STATE_ORDER.map((s) => {
          const v = visualFor(s)
          return (
            <li key={s}>
              <StateIconSvg icon={v.icon} className={v.className} />
              <span>
                {counts[s]} {v.label}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="summary__age">
        {status.noObservations || !status.lastObservedAt
          ? 'No observations yet'
          : `Last observed ${formatMinutes(minutesAgo(status.lastObservedAt))} ago`}
      </p>
    </section>
  )
}

function formatMinutes(m: number): string {
  return m === 1 ? '1 minute' : `${m} minutes`
}

function Legend() {
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
          <StateIconSvg icon="empty" className="space--free space--stale" />
          Dimmed: out of date
        </li>
        <li>
          <AdminBadgeIcon />
          Set by admin
        </li>
      </ul>
    </section>
  )
}
