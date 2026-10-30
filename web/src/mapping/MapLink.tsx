import { Link } from 'react-router-dom'
import { useAdminLot } from '../admin/AdminLotContext'

/** Admin home "Map" link: the picked lot's mapping page (brief §8.1). */
export function MapLink() {
  const { lotId, lots } = useAdminLot()
  if (!lotId) {
    return (
      <span className="admin-link admin-link--disabled" aria-disabled="true">
        Map {lots && <span className="muted">(no lots yet)</span>}
      </span>
    )
  }
  return (
    <Link to={`/admin/lots/${encodeURIComponent(lotId)}/map`} className="admin-link">
      Map
    </Link>
  )
}
