import { useState } from 'react'
import { fitGrid, gridSizes, shiftGrid, type Grid, type GridSizes } from './schematic/grid'
import type { DraftLayout } from './types'

/** The schematic grid as the mapping page keeps it, and its controls. */
export interface GridControls {
  grid: Grid
  /** Snapping on: moves, resizes and new spaces land on the grid, and moved spaces take their cell's label. */
  snap: boolean
  setSnap: (on: boolean) => void
  show: boolean
  setShow: (on: boolean) => void
  setSizes: (sizes: Partial<GridSizes>) => void
  /** Fit the grid to the spaces' labels again, at the sizes they suggest. */
  refit: () => void
}

interface Prefs {
  snap: boolean
  show: boolean
  sizes: Partial<GridSizes>
}

const DEFAULT_PREFS: Prefs = { snap: true, show: true, sizes: {} }
const prefsKey = (lotId: string) => `schematic-grid:${lotId}`

// The grid lives in this browser only (the draft has no place for it): snap/show and any sizes the admin
// set. Storage can be missing or blocked, and then the defaults apply.
function readPrefs(lotId: string): Prefs {
  try {
    const raw = localStorage.getItem(prefsKey(lotId))
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS
  } catch {
    return DEFAULT_PREFS
  }
}

function writePrefs(lotId: string, prefs: Prefs) {
  try {
    localStorage.setItem(prefsKey(lotId), JSON.stringify(prefs))
  } catch {
    // Not kept for next time; this session still uses it.
  }
}

/**
 * How far every space moved between two drafts, when the map grew left or up (fitSchematic shifts all
 * spaces together) or an undo took that back; null otherwise. Most spaces moved by exactly the same amount
 * then, which a single moved space never does.
 */
export function uniformShift(a: DraftLayout, b: DraftLayout): { dx: number; dy: number } | null {
  if (a.schematic.width === b.schematic.width && a.schematic.height === b.schematic.height) return null
  const before = new Map(a.spaces.map((s) => [s.spaceId, s.rect]))
  const counts = new Map<string, number>()
  let common = 0
  for (const s of b.spaces) {
    const r = before.get(s.spaceId)
    if (!r) continue
    common++
    const key = `${s.rect.x - r.x},${s.rect.y - r.y}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (common < 2) return null
  const [key, n] = [...counts].reduce((best, e) => (e[1] > best[1] ? e : best))
  if (n * 2 <= common) return null
  const [dx, dy] = key.split(',').map(Number)
  return dx !== 0 || dy !== 0 ? { dx, dy } : null
}

/**
 * The mapping page's schematic grid. It is fitted to the spaces' labels when a lot (and published version)
 * loads, not after every edit, so it stays put while spaces move; it follows the map when growing shifts
 * every space. Null until the draft loads.
 */
export function useSchematicGrid(lotId: string, draft: DraftLayout | null): GridControls | null {
  const [prefs, setPrefs] = useState<{ lotId: string; prefs: Prefs }>(() => ({ lotId, prefs: readPrefs(lotId) }))
  const current = prefs.lotId === lotId ? prefs.prefs : readPrefs(lotId)
  if (prefs.lotId !== lotId) setPrefs({ lotId, prefs: current })

  const baseKey = draft ? `${draft.lotId}:${draft.basedOnVersion}` : null
  const [state, setState] = useState<{ key: string; grid: Grid; seen: DraftLayout } | null>(null)
  if (draft && baseKey && state?.key !== baseKey) {
    setState({ key: baseKey, grid: fitGrid(draft.spaces, current.sizes), seen: draft })
  } else if (draft && state && draft !== state.seen) {
    const shift = uniformShift(state.seen, draft)
    setState({ ...state, seen: draft, grid: shift ? shiftGrid(state.grid, shift.dx, shift.dy) : state.grid })
  }
  if (!draft || !state || state.key !== baseKey) return null

  const update = (next: Prefs) => {
    setPrefs({ lotId, prefs: next })
    writePrefs(lotId, next)
  }
  return {
    grid: state.grid,
    snap: current.snap,
    setSnap: (snap) => update({ ...current, snap }),
    show: current.show,
    setShow: (show) => update({ ...current, show }),
    setSizes: (sizes) => {
      const next = { ...gridSizes(state.grid), ...current.sizes, ...sizes }
      update({ ...current, sizes: next })
      setState({ ...state, grid: fitGrid(draft.spaces, next) })
    },
    refit: () => {
      update({ ...current, sizes: {} })
      setState({ ...state, grid: fitGrid(draft.spaces) })
    },
  }
}
