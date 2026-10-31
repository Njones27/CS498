import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, errorMessage } from '../api/client'
import type { ProposalRun, ProposedStall } from './proposals'

/** How often the page asks whether the proposer has finished. */
export const POLL_MS = 2000

export type FinderState =
  | { phase: 'idle' }
  | { phase: 'running'; viewId: string }
  | { phase: 'failed'; viewId: string; message: string }

/** What the hook is doing, tagged with the lot and view it was for. */
type Tracked =
  | { phase: 'idle' }
  | { phase: 'running'; lotId: string; viewId: string; runId: string | null; tick: number }
  | { phase: 'failed'; lotId: string; viewId: string; message: string }

export const proposalsPath = (lotId: string, viewId: string) =>
  `/admin/lots/${encodeURIComponent(lotId)}/views/${encodeURIComponent(viewId)}/proposals`

/**
 * Find stalls on a viewpoint's reference photo (HDD §4.6): ask the API for a proposer run, poll it every
 * POLL_MS, and hand the stalls to `onStalls` once it completes. A run already going for this photo (409
 * proposal_running, e.g. from another tab) is followed rather than started again. Switching lot or view
 * stops following; the run itself carries on in the worker.
 */
export function useStallFinder(
  lotId: string,
  viewId: string | null,
  onStalls: (viewId: string, stalls: ProposedStall[]) => void,
) {
  const [tracked, setTracked] = useState<Tracked>({ phase: 'idle' })
  const onStallsRef = useRef(onStalls)
  useEffect(() => {
    onStallsRef.current = onStalls
  })

  // Only what belongs to the lot and view on screen counts; anything else reads as idle.
  const current = tracked.phase !== 'idle' && tracked.lotId === lotId && tracked.viewId === viewId ? tracked : null
  const running = current?.phase === 'running' ? current : null

  useEffect(() => {
    if (!running || running.runId === null) return
    let cancelled = false
    const { lotId: lot, viewId: view } = running
    const timer = window.setTimeout(async () => {
      let next: Tracked
      try {
        const run = await api.get<ProposalRun>(proposalsPath(lot, view))
        const done = run.status === 'COMPLETE' || run.status === 'FAILED'
        if (!done) {
          // Still going, or replaced by a newer request: follow whichever run is current.
          next = { ...running, runId: run.runId, tick: running.tick + 1 }
        } else if (run.status === 'FAILED') {
          next = { phase: 'failed', lotId: lot, viewId: view, message: run.error ?? 'Finding stalls failed' }
        } else if (run.photoChanged) {
          next = { phase: 'failed', lotId: lot, viewId: view, message: 'The reference photo changed; run it again' }
        } else {
          next = { phase: 'idle' }
          if (!cancelled) onStallsRef.current(view, run.stalls ?? [])
        }
      } catch (e) {
        next = { phase: 'failed', lotId: lot, viewId: view, message: errorMessage(e) }
      }
      if (!cancelled) setTracked(next)
    }, POLL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [running])

  const find = useCallback(async () => {
    if (!viewId || running) return
    const base = { phase: 'running' as const, lotId, viewId, tick: 0 }
    setTracked({ ...base, runId: null })
    try {
      const run = await api.post<ProposalRun>(proposalsPath(lotId, viewId))
      setTracked({ ...base, runId: run.runId })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'proposal_running') {
        const runId = (e.body as { runId?: string }).runId ?? ''
        setTracked({ ...base, runId })
        return
      }
      setTracked({ phase: 'failed', lotId, viewId, message: errorMessage(e) })
    }
  }, [lotId, viewId, running])

  const state: FinderState =
    current === null
      ? { phase: 'idle' }
      : current.phase === 'running'
        ? { phase: 'running', viewId: current.viewId }
        : { phase: 'failed', viewId: current.viewId, message: current.message }
  return { state, find }
}
