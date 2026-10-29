import { Link } from 'react-router-dom'
import { useAdminLot } from '../admin/AdminLotContext'
import { MapLink } from '../mapping/MapLink'

export function AdminHomePage() {
  const { lotId, lots } = useAdminLot()
  const lot = lots?.find((l) => l.lotId === lotId)
  return (
    <main className="page page--narrow">
      <h1>Admin</h1>
      {lot && (
        <p className="hint">
          Working on <strong>{lot.name}</strong>
          {!lot.published && ' (not published yet)'}. Switch lots with the picker at the top.
        </p>
      )}
      <ul className="admin-links">
        <li>
          <Link to="/admin/upload" className="admin-link">
            Upload
          </Link>
        </li>
        <li>
          <Link to="/admin/snapshots" className="admin-link">
            Snapshots
          </Link>
        </li>
        <li>
          <Link to="/admin/closures" className="admin-link">
            Closures
          </Link>
        </li>
        <li>
          <MapLink />
        </li>
        <li>
          <Link to="/admin/lots/new" className="admin-link">
            New lot
          </Link>
        </li>
      </ul>
    </main>
  )
}
