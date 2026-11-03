import { useState } from 'react'
import { anchorGrid, fitGrid, gridSizes, shiftGrid, type Grid, type GridSizes } from './schematic/grid'
import type { DraftLayout, DraftRect } from './types'

/** The schematic grid as the mapping page keeps it, and its controls. */
export interface GridControls {
  grid: Grid
  /** Snapping on: moves, resizes and new spaces land on the grid, and moved spaces take their cell's label. */
  snap: boolean
  setSnap: (on: boolean) => void
  show: boolean
  setShow: (on: boolean) => void
  setSizes: (sizes: Partial<GridSizes>) => void
  /**
   * Fit grid: to one space (it then exactly fills the cell it sits in; the grid takes its size and keeps
   * the gaps), or with none given, to all the spaces' labels at the sizes they suggest.
   */
  fitTo: (space: { rect: DraftRect; label: string } | null) => void
  /**
   * An edit that grew the map left or up moved every space by (dx, dy) on its way to `next`: move the grid
   * with them. Edits say so exactly; undo and redo, which don't, are recognised by uniformShift.
   */
  shiftBy: (next: DraftLayout, dx: number, dy: number) => void
  /** An edit that laid the whole lot out again (Straighten from photo): fit the grid to `next` afresh. */
  refit: (next: DraftLayout) => void
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
    // Rounded: (x + dx) - x is not always exactly dx in floating point.
    const key = `${Math.round((s.rect.x - r.x) * 1000)},${Math.round((s.rect.y - r.y) * 1000)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (common < 2) return null
  const [key, n] = [...counts].reduce((best, e) => (e[1] > best[1] ? e : best))
  if (n * 2 <= common) return null
  const [dx, dy] = key.split(',').map((v) => Number(v) / 1000)
  return dx !== 0 || dy !== 0 ? { dx, dy } : null
}

/** Stable signature of spaces' labels and coordinates for associating grids with draft snapshots. */
export function layoutSignature(draft: DraftLayout): string {
  return draft.spaces
    .map(
      (s) =>
        `${s.spaceId}:${s.label}:${Math.round(s.rect.x)},${Math.round(s.rect.y)},${Math.round(s.rect.w)},${Math.round(s.rect.h)}`,
    )
    .sort()
    .join(';')
}

function recordGrid(history: Map<string, Grid>, sig: string, grid: Grid): Map<string, Grid> {
  const next = new Map(history)
  if (next.has(sig)) {
    next.delete(sig)
  } else if (next.size >= 50) {
    const firstKey = next.keys().next().value
    if (firstKey !== undefined) next.delete(firstKey)
  }
  next.set(sig, grid)
  return next
}

function applySizesToGrid(g: Grid, sizes: Partial<GridSizes>): Grid {
  const currentSizes = gridSizes(g)
  const nextSizes = { ...currentSizes, ...sizes }
  const gapX = nextSizes.gapX
  const gapY = nextSizes.gapY
  const boxW = nextSizes.boxW
  const boxH = nextSizes.boxH
  const cellW = boxW + gapX
  const cellH = boxH + gapY
  return {
    ...g,
    boxW,
    boxH,
    cellW,
    cellH,
  }
}

function updateHistorySizes(history: Map<string, Grid>, sizes: Partial<GridSizes>): Map<string, Grid> {
  const next = new Map<string, Grid>()
  for (const [sig, g] of history) {
    next.set(sig, applySizesToGrid(g, sizes))
  }
  return next
}

interface GridState {
  key: string
  grid: Grid
  seen: DraftLayout
  history: Map<string, Grid>
}

/**
 * The mapping page's schematic grid. It is fitted to the spaces' labels when a lot (and published version)
 * loads, and once more when an empty lot gets its first spaces, not after every edit, so it stays put while spaces move; it follows the map when growing shifts
 * every space. Null until the draft loads.
 */
export function useSchematicGrid(lotId: string, draft: DraftLayout | null): GridControls | null {
  const [prefs, setPrefs] = useState<{ lotId: string; prefs: Prefs }>(() => ({ lotId, prefs: readPrefs(lotId) }))
  const current = prefs.lotId === lotId ? prefs.prefs : readPrefs(lotId)
  if (prefs.lotId !== lotId) setPrefs({ lotId, prefs: current })

  const baseKey = draft ? `${draft.lotId}:${draft.basedOnVersion}` : null
  const [state, setState] = useState<GridState | null>(null)

  if (draft && baseKey && state?.key !== baseKey) {
    const initialGrid = fitGrid(draft.spaces, current.sizes)
    const history = new Map([[layoutSignature(draft), initialGrid]])
    setState({ key: baseKey, grid: initialGrid, seen: draft, history })
  } else if (draft && state && state.seen.spaces.length === 0 && draft.spaces.length > 0) {
    // A grid fitted to an empty lot has nothing to go by; fit it to the first spaces (say, found stalls).
    const initialGrid = fitGrid(draft.spaces, current.sizes)
    const history = recordGrid(state.history, layoutSignature(draft), initialGrid)
    setState({ ...state, grid: initialGrid, seen: draft, history })
  } else if (draft && state && draft !== state.seen) {
    const sig = layoutSignature(draft)
    const remembered = state.history.get(sig)
    if (remembered) {
      setState({ ...state, seen: draft, grid: remembered })
    } else {
      const shift = uniformShift(state.seen, draft)
      const nextGrid = shift ? shiftGrid(state.grid, shift.dx, shift.dy) : state.grid
      setState({ ...state, seen: draft, grid: nextGrid })
    }
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
      const newGrid = fitGrid(draft.spaces, next)
      const history = updateHistorySizes(state.history, next)
      setState({ ...state, seen: draft, grid: newGrid, history })
    },
    fitTo: (space) => {
      if (!space) {
        update({ ...current, sizes: {} })
        const newGrid = fitGrid(draft.spaces)
        const sizes = gridSizes(newGrid)
        const history = updateHistorySizes(state.history, sizes)
        return setState({ ...state, seen: draft, grid: newGrid, history })
      }
      const grid = anchorGrid(state.grid, space.rect, space.label)
      const sizes = gridSizes(grid)
      update({ ...current, sizes })
      const history = updateHistorySizes(state.history, sizes)
      setState({ ...state, seen: draft, grid, history })
    },
    shiftBy: (next, dx, dy) => {
      const shifted = shiftGrid(state.grid, dx, dy)
      const history = recordGrid(state.history, layoutSignature(next), shifted)
      setState({ ...state, seen: next, grid: shifted, history })
    },
    refit: (next) => {
      update({ ...current, sizes: {} })
      const newGrid = fitGrid(next.spaces)
      const history = recordGrid(state.history, layoutSignature(next), newGrid)
      setState({ ...state, seen: next, grid: newGrid, history })
    },
  }
}
