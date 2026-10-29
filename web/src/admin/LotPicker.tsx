import type { ChangeEvent } from 'react'
import { Link, generatePath, matchPath, useLocation, useNavigate } from 'react-router-dom'
import { useAdminLot } from './AdminLotContext'
import { LOT_ROUTE } from './adminLot'

/** Header lot picker for admins (US-16 #3). Pages with the lot in their URL move to the new lot. */
export function LotPicker() {
  const { lotId, lots, error, switchLot } = useAdminLot()
  const { pathname } = useLocation()
  const navigate = useNavigate()

  if (error && !lots) return <span className="lot-picker lot-picker--error">Lots unavailable</span>
  if (!lots) return <span className="lot-picker muted">Loading lots…</span>
  if (lots.length === 0) {
    return (
      <span className="lot-picker">
        <span className="muted">No lots yet</span> <Link to="/admin/lots/new">New lot</Link>
      </span>
    )
  }

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value
    switchLot(next)
    const match = matchPath(LOT_ROUTE, pathname)
    if (match && match.params.lotId !== 'new') {
      navigate(generatePath(LOT_ROUTE, { lotId: next, '*': match.params['*'] ?? '' }))
    }
  }

  return (
    <span className="lot-picker">
      {/* Not a <label>: named "Lot picker" so it never collides with a page's own "Lot" field. */}
      <span className="lot-picker__label" aria-hidden="true">
        Lot
      </span>
      <select value={lotId} onChange={onChange} aria-label="Lot picker">
        {lots.map((l) => (
          <option key={l.lotId} value={l.lotId}>
            {l.published ? l.name : `${l.name} (not published)`}
          </option>
        ))}
      </select>
      <Link to="/admin/lots/new" className="lot-picker__new">
        New lot
      </Link>
    </span>
  )
}
