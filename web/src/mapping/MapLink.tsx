import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { LotListItem } from '../api/schemas'
import { useFetch } from '../lib/useFetch'
import { ADMIN_LOT_KEY } from '../pages/UploadPage'

function rememberedLot(): string {
  try {
    return localStorage.getItem(ADMIN_LOT_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Admin home "Map" link: the picked lot (`parking.admin.lotId`), else the first lot (brief §8.1). */
export function MapLink() {
  const [storedLotId] = useState(rememberedLot)
  const lots = useFetch<LotListItem[] | null>(
    () => (storedLotId ? Promise.resolve(null) : api.get<LotListItem[]>('/lots')),
    `map-link-lots:${storedLotId}`,
  )
  const lotId = storedLotId || lots.data?.[0]?.lotId || ''
  if (!lotId) {
    return (
      <span className="admin-link admin-link--disabled" aria-disabled="true">
        Map {!lots.loading && <span className="muted">(no lots yet)</span>}
      </span>
    )
  }
  return (
    <Link to={`/admin/lots/${encodeURIComponent(lotId)}/map`} className="admin-link">
      Map
    </Link>
  )
}
