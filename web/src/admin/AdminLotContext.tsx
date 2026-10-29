import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { api } from '../api/client'
import type { AdminLotOut } from '../api/lotsAdmin'
import { useAuth } from '../auth/AuthContext'
import { useFetch } from '../lib/useFetch'
import { LOT_ROUTE, byName, readStoredLot, resolveLotId, storeLot } from './adminLot'

export interface AdminLotState {
  /** The picked lot: the remembered one while it exists, else the first published lot, else the first lot. */
  lotId: string
  /** Remember a lot without remounting the page (e.g. a page's own lot select). */
  setLotId: (lotId: string) => void
  /** The header picker's switch: remembers the lot and remounts the page so it reloads (US-16 #3). */
  switchLot: (lotId: string) => void
  /** Add a just-created lot to the list and pick it, before the list reloads. */
  lotCreated: (lot: AdminLotOut) => void
  /** Every lot, published or not (`GET /admin/lots`); null until loaded. */
  lots: AdminLotOut[] | null
  error: string | null
  reload: () => void
  /** Bumped by switchLot; AppShell keys the page on it. */
  generation: number
}

const NOOP = () => {}
const AdminLotContext = createContext<AdminLotState>({
  lotId: '',
  setLotId: NOOP,
  switchLot: NOOP,
  lotCreated: NOOP,
  lots: null,
  error: null,
  reload: NOOP,
  generation: 0,
})

/** Holds the admin's picked lot for every admin page (US-16 #3). Loads lots only for admins. */
export function AdminLotProvider({ children }: { children: ReactNode }) {
  const { session, isAdmin } = useAuth()
  const enabled = !!session && isAdmin
  const fetched = useFetch<AdminLotOut[] | null>(
    () => (enabled ? api.get<AdminLotOut[]>('/admin/lots') : Promise.resolve(null)),
    `admin-lots:${enabled ? session.email : ''}`,
  )
  const { reload: reloadLots } = fetched
  const [created, setCreated] = useState<AdminLotOut[]>([])
  const [stored, setStored] = useState(readStoredLot)
  const [generation, setGeneration] = useState(0)

  const lots = useMemo(() => {
    if (!fetched.data) return created.length ? [...created].sort(byName) : null
    const missing = created.filter((c) => !fetched.data!.some((l) => l.lotId === c.lotId))
    return missing.length ? [...fetched.data, ...missing].sort(byName) : fetched.data
  }, [fetched.data, created])

  // Written straight away (not in an effect): a page remounted by switchLot reads storage on mount.
  const setLotId = useCallback((lotId: string) => {
    setStored(lotId)
    storeLot(lotId)
  }, [])

  const switchLot = useCallback(
    (lotId: string) => {
      setLotId(lotId)
      setGeneration((g) => g + 1)
    },
    [setLotId],
  )

  const lotCreated = useCallback(
    (lot: AdminLotOut) => {
      setCreated((c) => [...c.filter((l) => l.lotId !== lot.lotId), lot])
      setLotId(lot.lotId)
      reloadLots()
    },
    [setLotId, reloadLots],
  )

  // A page that carries the lot in its URL (the mapping page) decides the picked lot.
  const { pathname } = useLocation()
  const urlLotId = matchPath(LOT_ROUTE, pathname)?.params.lotId
  const routeLot = enabled && urlLotId && urlLotId !== 'new' && lots?.some((l) => l.lotId === urlLotId) ? urlLotId : ''
  if (routeLot && routeLot !== stored) setStored(routeLot)
  useEffect(() => {
    if (routeLot) storeLot(routeLot)
  }, [routeLot])

  const value: AdminLotState = {
    lotId: resolveLotId(stored, lots),
    setLotId,
    switchLot,
    lotCreated,
    lots,
    error: fetched.error,
    reload: reloadLots,
    generation,
  }
  return <AdminLotContext.Provider value={value}>{children}</AdminLotContext.Provider>
}

/** The admin's picked lot and the lot list (`GET /admin/lots`), shared by every admin page. */
export function useAdminLot(): AdminLotState {
  return useContext(AdminLotContext)
}
