import type { AdminLotOut } from '../api/lotsAdmin'

/** localStorage key for the admin's picked lot (US-16 #3). */
export const ADMIN_LOT_KEY = 'parking.admin.lotId'

/** Admin pages whose URL carries the lot: the picker follows them and switching rewrites them. */
export const LOT_ROUTE = '/admin/lots/:lotId/*'

export function readStoredLot(): string {
  try {
    return localStorage.getItem(ADMIN_LOT_KEY) ?? ''
  } catch {
    return ''
  }
}

export function storeLot(lotId: string) {
  try {
    localStorage.setItem(ADMIN_LOT_KEY, lotId)
  } catch {
    // storage unavailable; the picker just will not remember
  }
}

/** The remembered lot while it exists, else the first published lot, else the first lot. */
export function resolveLotId(stored: string, lots: AdminLotOut[] | null): string {
  if (!lots || lots.some((l) => l.lotId === stored)) return stored
  return (lots.find((l) => l.published) ?? lots[0])?.lotId ?? ''
}

export const byName = (a: AdminLotOut, b: AdminLotOut) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.lotId.localeCompare(b.lotId)
