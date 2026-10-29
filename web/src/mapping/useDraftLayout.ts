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

/** One page holds one draft (brief §4.1 "Saving model"): load, local edits, save(), reload(). */
export function useDraftLayout(lotId: string): DraftLayoutState {
  const [draft, setDraftState] = useState<DraftLayout | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [tick, setTick] = useState(0)

  // Refs mirror state so save() always sends the latest draft and can tell whether edits
  // arrived while a save was in flight.
  const draftRef = useRef<DraftLayout | null>(null)
  const editsRef = useRef(0)
  const inFlight = useRef<Promise<DraftLayout | null> | null>(null)
  const lotRef = useRef(lotId)
  useEffect(() => {
    lotRef.current = lotId
  }, [lotId])

  const replace = (next: DraftLayout | null) => {
    draftRef.current = next
    setDraftState(next)
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
        editsRef.current = 0
        setDirty(false)
        setStale(false)
        setSaveError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        replace(null)
        setError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [lotId, tick])

  const setDraft = useCallback((next: DraftLayout) => {
    editsRef.current += 1
    replace(next)
    setDirty(true)
  }, [])

  const save = useCallback((): Promise<DraftLayout | null> => {
    if (inFlight.current) return inFlight.current
    const current = draftRef.current
    if (!current) return Promise.resolve(null)
    const savedLot = lotRef.current
    const editsAtStart = editsRef.current
    setSaving(true)
    setSaveError(null)
    const run = api
      .put<DraftLayout>(draftPath(savedLot), toDraftUpdate(current))
      .then((saved) => {
        if (lotRef.current !== savedLot) return null
        if (editsRef.current === editsAtStart) {
          replace(saved)
          setDirty(false)
        } else {
          // Edits made during the save stay local and dirty; they go out with the new revision.
          const local = draftRef.current ?? saved
          replace({ ...local, revision: saved.revision, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy })
        }
        setStale(false)
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

  const reload = useCallback(() => setTick((t) => t + 1), [])

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
    replace({
      ...local,
      viewpoints: local.viewpoints.map((v) => (refs.has(v.viewId) ? { ...v, referenceImage: refs.get(v.viewId) ?? null } : v)),
    })
  }, [])

  // Never hand out the previous lot's draft while the new one loads.
  const current = draft && draft.lotId === lotId ? draft : null
  return { draft: current, loading, error, saving, saveError, stale, dirty, setDraft, save, reload, refreshReferenceImages }
}
