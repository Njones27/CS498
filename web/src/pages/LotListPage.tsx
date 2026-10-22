import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { LotListItem } from '../api/schemas'
import { displayOpenPercent, fullnessFor } from '../lib/fullness'
import { useFetch } from '../lib/useFetch'

/** US-15: every lot with how full it is. Public; never asks to sign in. */
export function LotListPage() {
  const { data, error, loading, reload } = useFetch(() => api.get<LotListItem[]>('/lots'), 'lots')

  return (
    <main className="page">
      <div className="page__head">
        <h1>Parking lots</h1>
        <button type="button" className="button" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {loading && !data && <p>Loading…</p>}
      {data && data.length === 0 && <p>No lots are published yet.</p>}
      <ul className="lot-list">
        {data?.map((lot) => <LotRow key={lot.lotId} lot={lot} />)}
      </ul>
    </main>
  )
}

function LotRow({ lot }: { lot: LotListItem }) {
  const { summary } = lot
  const openPercent = displayOpenPercent(summary)
  const fullness = fullnessFor(openPercent)
  const hasData = openPercent !== null
  const pct = openPercent ?? 0

  return (
    <li>
      <Link to={`/lots/${encodeURIComponent(lot.lotId)}`} className="lot-row" data-testid="lot-row">
        <div className="lot-row__top">
          <span className="lot-row__name">{lot.name}</span>
          <span className="lot-row__count">
            {summary.free}/{summary.total} open
          </span>
        </div>
        <div
          className={`bar bar--${fullness.level}`}
          role="meter"
          aria-label={`${lot.name} open spaces`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={hasData ? pct : undefined}
          aria-valuetext={hasData ? `${pct}% open, ${fullness.label}` : 'no recent data'}
        >
          <div className="bar__fill" style={{ width: hasData ? `${pct}%` : '100%' }} />
        </div>
        <div className="lot-row__bottom">
          {hasData ? (
            <span>
              <strong>{pct}% open</strong> · <span className={`level level--${fullness.level}`}>{fullness.label}</span>
            </span>
          ) : (
            <span className="muted">no recent data</span>
          )}
          {summary.isStale && <span className="stale-note">Some data out of date</span>}
        </div>
      </Link>
    </li>
  )
}
