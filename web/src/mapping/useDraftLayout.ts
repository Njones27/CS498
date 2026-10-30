import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, errorMessage } from '../api/client'
import type { DraftLayout, DraftLayoutUpdate } from './types'

export interface DraftLayoutState {
  /** The page's in-memory draft: the last load or save, plus any local edits. */
  draft: DraftLayout | null
  loading: boolean
  /** Load failure (e.g. "Lot not found"). */
  error: string | null
  saving: boolean
  /** Last save failure, other than a stale revision. */
  saveError: string | null
  /** True once a save hit 409 stale_revision: the draft changed elsewhere and must be reloaded. */
  stale: boolean
  /** Local edits not yet saved. */
  dirty: boolean
  /** Note shown after a successful save (e.g. "Draft saved"). */
  savedNote: string | null
  /** Panels' `onChange`: replace the in-memory draft. Nothing is sent until save(). */
  setDraft: (next: DraftLayout) => void
  /** Save the draft; resolves to the saved draft, or null when the save failed. */
  save: () => Promise<DraftLayout | null>
  /** Refetch the stored draft, discarding local edits. */
  reload: () => void
  /**
   * Pick up reference photos uploaded since the last load, keeping local edits. Reference uploads
   * never bump the revision (brief §4.2), so the local revision stays valid.
   */
  refreshReferenceImages: () => Promise<void>
  /** Whether there are prior states to undo. */
  canUndo: boolean
  /** Whether there are undone states to redo. */
  canRedo: boolean
  /** Undo the most recent local edit. */
  undo: () => void
  /** Redo the most recent undone edit. */
  redo: () => void
  /** Whether autosave is currently enabled. */
  autosave: boolean
  /** Toggle autosave. */
  setAutosave: (value: boolean | ((prev: boolean) => boolean)) => void
}

export interface UseDraftLayoutOptions {
  /** Initial autosave setting. If omitted, reads from localStorage['parking.autosave'] or false. */
  autosave?: boolean
  /** Debounce delay in ms for autosave. Defaults to 1500ms. */
  debounceMs?: number
}

/** The PUT body for a draft: drops the server-owned fields (brief §4.1). */
export function toDraftUpdate(draft: DraftLayout): DraftLayoutUpdate {
  return {
    revision: draft.revision,
    schematic: draft.schematic,
    spaces: draft.spaces,
    viewpoints: draft.viewpoints.map(({ viewId, name, outlines, outlineReview }) => ({
      viewId,
      name,
      outlines,
      outlineReview,
    })),
  }
}

export const draftPath = (lotId: string) => `/admin/lots/${encodeURIComponent(lotId)}/layout/draft`

const MAX_HISTORY = 50

/** One page holds one draft (brief §4.1 "Saving model"): load, local edits, save(), reload(). */
export function useDraftLayout(lotId: string, options?: UseDraftLayoutOptions): DraftLayoutState {
  const [draft, setDraftState] = useState<DraftLayout | null>(null)
  const [history, setHistory] = useState<{ past: DraftLayout[]; future: DraftLayout[] }>({
    past: [],
    future: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const [autosave, setAutosaveState] = useState<boolean>(() => {
    if (typeof options?.autosave === 'boolean') return options.autosave
    try {
      return localStorage.getItem('parking.autosave') === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (typeof options?.autosave === 'boolean') {
      setAutosaveState(options.autosave)
    }
  }, [options?.autosave])

  const setAutosave = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    setAutosaveState((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      try {
        localStorage.setItem('parking.autosave', String(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  const dirtyRef = useRef(false)
  const setDirtyTracked = (d: boolean) => {
    dirtyRef.current = d
    setDirty(d)
  }

  // Refs mirror state so save() always sends the latest draft and can tell whether edits
  // arrived while a save was in flight.
  const draftRef = useRef<DraftLayout | null>(null)
  const historyRef = useRef<{ past: DraftLayout[]; future: DraftLayout[] }>({
    past: [],
    future: [],
  })
  const editsRef = useRef(0)
  const inFlight = useRef<Promise<DraftLayout | null> | null>(null)
  /** editsRef when the in-flight save started: the edits it carries. */
  const inFlightEdits = useRef(0)
  const lotRef = useRef(lotId)
  useEffect(() => {
    lotRef.current = lotId
  }, [lotId])

  const replace = (next: DraftLayout | null) => {
    draftRef.current = next
    setDraftState(next)
  }

  const resetHistory = () => {
    const empty = { past: [], future: [] }
    historyRef.current = empty
    setHistory(empty)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .get<DraftLayout>(draftPath(lotId))
      .then((d) => {
        if (cancelled) return
        replace(d)
        resetHistory()
        editsRef.current = 0
        setDirtyTracked(false)
        setStale(false)
        setSaveError(null)
        setSavedNote(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        replace(null)
        resetHistory()
        setError(errorMessage(e))
        setSavedNote(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [lotId, tick])

  const setDraft = useCallback((next: DraftLayout) => {
    const current = draftRef.current
    if (!current || next === current) return
    const nextPast = [...historyRef.current.past.slice(-(MAX_HISTORY - 1)), current]
    const nextHistory = { past: nextPast, future: [] }
    historyRef.current = nextHistory
    setHistory(nextHistory)

    editsRef.current += 1
    replace(next)
    setDirtyTracked(true)
    setSavedNote(null)
  }, [])

  const undo = useCallback(() => {
    const current = draftRef.current
    const h = historyRef.current
    if (!current || h.past.length === 0) return
    const prev = h.past[h.past.length - 1]
    const nextPast = h.past.slice(0, -1)
    const nextFuture = [current, ...h.future]
    const nextHistory = { past: nextPast, future: nextFuture }
    historyRef.current = nextHistory
    setHistory(nextHistory)

    const restored: DraftLayout = {
      ...prev,
      revision: current.revision,
      updatedAt: current.updatedAt,
      updatedBy: current.updatedBy,
    }
    editsRef.current += 1
    replace(restored)
    setDirtyTracked(true)
    setSavedNote(null)
  }, [])

  const redo = useCallback(() => {
    const current = draftRef.current
    const h = historyRef.current
    if (!current || h.future.length === 0) return
    const next = h.future[0]
    const nextFuture = h.future.slice(1)
    const nextPast = [...h.past, current]
    const nextHistory = { past: nextPast, future: nextFuture }
    historyRef.current = nextHistory
    setHistory(nextHistory)

    const restored: DraftLayout = {
      ...next,
      revision: current.revision,
      updatedAt: current.updatedAt,
      updatedBy: current.updatedBy,
    }
    editsRef.current += 1
    replace(restored)
    setDirtyTracked(true)
    setSavedNote(null)
  }, [])

  const save = useCallback(function saveDraft(): Promise<DraftLayout | null> {
    if (inFlight.current) {
      // Join the save in flight, unless edits were made after it started (an outline committed
      // right after the last one): those go out in one more save once it lands.
      if (editsRef.current === inFlightEdits.current) return inFlight.current
      return inFlight.current.then((saved) => (saved ? saveDraft() : null))
    }
    const current = draftRef.current
    if (!current) return Promise.resolve(null)
    const savedLot = lotRef.current
    const editsAtStart = editsRef.current
    inFlightEdits.current = editsAtStart
    setSaving(true)
    setSaveError(null)
    const run = api
      .put<DraftLayout>(draftPath(savedLot), toDraftUpdate(current))
      .then((saved) => {
        if (lotRef.current !== savedLot) return null
        if (editsRef.current === editsAtStart) {
          replace(saved)
          setDirtyTracked(false)
        } else {
          // Edits made during the save stay local and dirty; they go out with the new revision.
          const local = draftRef.current ?? saved
          replace({ ...local, revision: saved.revision, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy })
        }
        const updateRev = (d: DraftLayout): DraftLayout => ({
          ...d,
          revision: saved.revision,
          updatedAt: saved.updatedAt,
          updatedBy: saved.updatedBy,
        })
        const nextHistory = {
          past: historyRef.current.past.map(updateRev),
          future: historyRef.current.future.map(updateRev),
        }
        historyRef.current = nextHistory
        setHistory(nextHistory)
        setStale(false)
        setSavedNote('Draft saved')
        return saved
      })
      .catch((e: unknown) => {
        if (lotRef.current !== savedLot) return null
        if (e instanceof ApiError && e.code === 'stale_revision') setStale(true)
        setSaveError(errorMessage(e))
        return null
      })
      .finally(() => {
        inFlight.current = null
        setSaving(false)
      })
    inFlight.current = run
    return run
  }, [])

  const reload = useCallback(() => {
    resetHistory()
    setSavedNote(null)
    setTick((t) => t + 1)
  }, [])

  const refreshReferenceImages = useCallback(async () => {
    const requestedLot = lotRef.current
    let fresh: DraftLayout
    try {
      fresh = await api.get<DraftLayout>(draftPath(requestedLot))
    } catch (e: unknown) {
      setSaveError(errorMessage(e))
      return
    }
    const local = draftRef.current
    if (lotRef.current !== requestedLot || !local || local.lotId !== fresh.lotId) return
    const refs = new Map(fresh.viewpoints.map((v) => [v.viewId, v.referenceImage]))
    const updateRefs = (d: DraftLayout): DraftLayout => ({
      ...d,
      viewpoints: d.viewpoints.map((v) => (refs.has(v.viewId) ? { ...v, referenceImage: refs.get(v.viewId) ?? null } : v)),
    })
    replace(updateRefs(local))
    const nextHistory = {
      past: historyRef.current.past.map(updateRefs),
      future: historyRef.current.future.map(updateRefs),
    }
    historyRef.current = nextHistory
    setHistory(nextHistory)
  }, [])

  const debounceMs = options?.debounceMs ?? 1500

  useEffect(() => {
    if (!autosave || !dirty || saving || stale || !draft) {
      return
    }
    const timer = setTimeout(() => {
      if (dirtyRef.current && !stale) {
        void save()
      }
    }, debounceMs)
    return () => clearTimeout(timer)
  }, [autosave, dirty, saving, stale, draft, save, debounceMs])

  // Never hand out the previous lot's draft while the new one loads.
  const current = draft && draft.lotId === lotId ? draft : null
  const canUndo = history.past.length > 0
  const canRedo = history.future.length > 0

  return {
    draft: current,
    loading,
    error,
    saving,
    saveError,
    stale,
    dirty,
    savedNote,
    setDraft,
    save,
    reload,
    refreshReferenceImages,
    canUndo,
    canRedo,
    undo,
    redo,
    autosave,
    setAutosave,
  }
}
