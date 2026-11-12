import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api, errorMessage } from '../api/client'
import type { LotDetail, SnapshotDetail } from '../api/schemas'
import { Main } from '../components/Main'
import { useFetch } from '../lib/useFetch'
import { ReferencePhotoPanel } from './ReferencePhotoPanel'
import { SchematicEditor } from './SchematicEditor'
import type { DraftLayout, Issue, LayoutVersionOut, MapShift, MappingSelection, ValidationReport } from './types'
import { draftPath, useDraftLayout } from './useDraftLayout'
import { useSchematicGrid } from './useSchematicGrid'
import { VALIDATE_HELP, VALIDATION_ID, ValidationPanel } from './ValidationPanel'

/** "Draft based on v3", or "Not published yet" for a lot that was never published (brief §8.5). */
function draftBasis(draft: DraftLayout): string {
  return draft.basedOnVersion == null ? 'Not published yet' : `Draft based on v${draft.basedOnVersion}`
}

const NO_ISSUES: Issue[] = []
const NO_SPACES: ReadonlySet<string> = new Set()

/** Navigation state the versions page sets after a Restore. */
export interface MappingLocationState {
  restoredFrom?: number
}

const layoutPath = (lotId: string) => `/admin/lots/${encodeURIComponent(lotId)}/layout`

/** Lot mapping page (Sketch 5): schematic editor, reference photo panel, validation, Save, Publish. */
export function LotMappingPage() {
  const { lotId = '' } = useParams()
  const {
    draft,
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
  } = useDraftLayout(lotId)
  const grid = useSchematicGrid(lotId, draft)
  const [photoShift, setPhotoShift] = useState({ dx: 0, dy: 0, n: 0 })
  /** Every panel edit goes through here: one that shifted every space (map grew left or up) moves the grid too. */
  function applyEdit(next: DraftLayout, shift?: MapShift) {
    if (shift) grid?.shiftBy(next, shift.dx, shift.dy)
    setDraft(next)
  }
  const location = useLocation()
  const navigate = useNavigate()
  const restoredFrom = (location.state as MappingLocationState | null)?.restoredFrom
  // Unpublished lots are not in the public API, so their header falls back to the lot id.
  const detail = useFetch<LotDetail | null>(
    () => api.get<LotDetail>(`/lots/${encodeURIComponent(lotId)}`).catch(() => null),
    `mapping-lot:${lotId}`,
  )
  const lotName = detail.data?.lot.name ?? lotId
  // The hook's savedNote says "Draft saved"; this page's own note says what Publish or Restore did.
  const [pageNote, setPageNote] = useState<string | null>(
    restoredFrom != null ? `Draft restored from v${restoredFrom}. Publish to make it live.` : null,
  )
  // The note is read once (above); drop it from history so a refresh or Back doesn't repeat it.
  useEffect(() => {
    if (restoredFrom != null) navigate(location.pathname, { replace: true, state: null })
  }, [restoredFrom, location.pathname, navigate])
  // A report describes the revision it checked. After an edit or another save it is out of date,
  // so it no longer marks spaces red or blocks Publish (which validates again on the server).
  const [checked, setChecked] = useState<{ report: ValidationReport; revision: number } | null>(null)
  const report = checked && !dirty && checked.revision === draft?.revision ? checked.report : null
  const [busy, setBusy] = useState<'validating' | 'publishing' | null>(null)
  // Publishing scores the latest photo again against the new version: followed until it is done.
  const [rescore, setRescore] = useState<{ version: number; imageIds: string[] } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // A publish refused with stale_revision: like a stale save, the draft must be reloaded.
  const [publishStale, setPublishStale] = useState<string | null>(null)

  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<ReadonlySet<string>>(NO_SPACES)
  // Spaces the draft had when this lot and version loaded may be published: those are retired, not
  // deleted, from either panel.
  const baseKey = draft ? `${draft.lotId}:${draft.basedOnVersion}` : ''
  const [baseline, setBaseline] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: '', ids: NO_SPACES })
  if (draft && baseline.key !== baseKey) setBaseline({ key: baseKey, ids: new Set(draft.spaces.map((s) => s.spaceId)) })
  // Published spaces are the live layout's; until it loads, every space the draft had when it loaded.
  const livePublished = useMemo(
    () => (detail.data ? new Set(detail.data.layout.spaces.map((sp) => sp.spaceId)) : null),
    [detail.data],
  )
  const publishedIds = livePublished ?? baseline.ids
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null)
  const [pickedViewId, setPickedViewId] = useState<string | null>(null)
  const viewpoints = draft?.viewpoints ?? []
  const viewId = viewpoints.some((v) => v.viewId === pickedViewId) ? pickedViewId : (viewpoints[0]?.viewId ?? null)
  const selection: MappingSelection = {
    selectedSpaceId,
    // Picking one space ends a Shift+click selection.
    onSelectSpace: (id) => {
      setSelectedSpaceId(id)
      if (id) setSelectedSpaceIds(NO_SPACES)
    },
    selectedSpaceIds,
    onSelectSpaces: setSelectedSpaceIds,
    hoveredSpaceId,
    onHoverSpace: setHoveredSpaceId,
  }
  // Panels highlight these spaces in red, so only errors; warnings stay in the report.
  const issues = report?.errors ?? NO_ISSUES
  const hasErrors = (report?.errors.length ?? 0) > 0
  const isStale = stale || publishStale != null

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Global keyboard shortcuts for Undo (Ctrl+Z / Cmd+Z) and Redo (Ctrl+Y / Cmd+Shift+Z)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod) return

      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }

      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        if (canUndo) {
          e.preventDefault()
          undo()
        }
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        if (canRedo) {
          e.preventDefault()
          redo()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canUndo, canRedo, undo, redo])

  async function onSave() {
    setPageNote(null)
    setActionError(null)
    await save()
  }

  async function onValidate() {
    setPageNote(null)
    setActionError(null)
    setBusy('validating')
    try {
      // Validate and Publish act on the stored draft, so they always save first: the report then
      // matches the screen, and a draft changed in another window comes back as stale.
      const current = await save()
      if (!current) return
      setChecked({ report: await api.post<ValidationReport>(`${draftPath(lotId)}/validate`), revision: current.revision })
      // The report is under the panels, out of sight: bring it into view.
      requestAnimationFrame(() => document.getElementById(VALIDATION_ID)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
    } catch (e: unknown) {
      setActionError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function onPublish() {
    setPageNote(null)
    setActionError(null)
    setBusy('publishing')
    let revision = 0
    try {
      const current = await save()
      if (!current) return
      revision = current.revision
      const published = await api.post<LayoutVersionOut>(`${layoutPath(lotId)}/publish`, { revision })
      setChecked(null)
      setPageNote(`Published v${published.version}`)
      setRescore(published.rescoring?.length ? { version: published.version, imageIds: published.rescoring } : null)
      detail.reload()
      reload() // publishing moves the draft to a new revision based on the new version
    } catch (e: unknown) {
      if (e instanceof ApiError && e.code === 'validation_failed') {
        const refused = (e.body as { report?: ValidationReport }).report
        setChecked(refused ? { report: refused, revision } : null)
        setActionError(e.message)
      } else if (e instanceof ApiError && e.code === 'stale_revision') {
        setPublishStale(e.message)
      } else {
        setActionError(errorMessage(e))
      }
    } finally {
      setBusy(null)
    }
  }

  function onReload() {
    setPageNote(null)
    setPublishStale(null)
    setActionError(null)
    reload()
  }

  return (
    <Main className="page mapping-page">
      <Link to="/admin" className="back-link">
        ← Admin
      </Link>
      <div className="mapping-head">
        <h1>
          Lot Mapping <span className="mapping-head__part">· {lotName}</span>
          {draft && <span className="mapping-head__part"> · {draftBasis(draft)}</span>}
        </h1>
        <div className="mapping-head__actions">
          <Link to={`/admin/lots/${encodeURIComponent(lotId)}/versions`} className="button button--ghost">
            Versions
          </Link>
          <button
            type="button"
            className="button"
            onClick={undo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z / Cmd+Z)"
            aria-label="Undo"
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="button"
            onClick={redo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y / Cmd+Shift+Z)"
            aria-label="Redo"
          >
            ↷ Redo
          </button>
          <label className="mapping-autosave" title="Automatically save changes after 1.5s of inactivity">
            <input
              type="checkbox"
              checked={autosave}
              onChange={(e) => setAutosave(e.target.checked)}
            />
            <span>Autosave</span>
          </label>
          <button
            type="button"
            className="button"
            onClick={onSave}
            disabled={!draft || saving || busy != null || isStale}
          >
            {saving && busy == null ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="button"
            onClick={onValidate}
            disabled={!draft || saving || busy != null || isStale}
            title={VALIDATE_HELP}
          >
            {busy === 'validating' ? 'Validating…' : 'Validate'}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={onPublish}
            disabled={!draft || saving || busy != null || isStale || hasErrors}
            title={hasErrors ? 'Fix the errors in the validation report first' : undefined}
          >
            {busy === 'publishing' ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>

      <p className="hint mapping-save-state" aria-live="polite">
        {draft && !isStale && (dirty ? 'Unsaved changes' : (savedNote ?? pageNote ?? `Revision ${draft.revision}`))}
      </p>
      {rescore && <RescoreStatus key={rescore.imageIds.join()} {...rescore} onDone={() => setRescore(null)} />}
      {isStale && (
        <div className="notice notice--warn mapping-notice" role="alert">
          <span>{stale ? saveError : publishStale}</span>
          <button type="button" className="button" onClick={onReload}>
            Reload
          </button>
        </div>
      )}
      {!isStale && (saveError || actionError) && (
        <p className="notice notice--error" role="alert">
          {saveError ?? actionError}
        </p>
      )}
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {loading && !draft && !error && <p className="muted">Loading draft…</p>}

      {draft && (
        <>
          <div className="mapping-panels">
            <SchematicEditor
              {...selection}
              draft={draft}
              onChange={applyEdit}
              issues={issues}
              grid={grid}
              externalShift={photoShift}
              photoViewId={viewId}
              publishedSpaceIds={publishedIds}
            />
            <ReferencePhotoPanel
              {...selection}
              lotId={lotId}
              draft={draft}
              viewId={viewId}
              onViewChange={setPickedViewId}
              onChange={(next, shift) => {
                // The schematic keeps its pinned view over the same spaces when a photo edit shifts them.
                if (shift) setPhotoShift((s) => ({ ...shift, n: s.n + 1 }))
                applyEdit(next, shift)
              }}
              onReferenceUploaded={(uploaded) => void refreshReferenceImages(uploaded)}
              issues={issues}
              onSave={save}
              grid={grid?.grid ?? null}
              snap={grid?.snap ?? false}
              onRelaid={(next) => grid?.refit(next)}
              publishedSpaceIds={publishedIds}
            />
          </div>
          <ValidationPanel report={report} draft={draft} onSelectSpace={setSelectedSpaceId} />
        </>
      )}
    </Main>
  )
}

/** How often the page asks whether a re-score has finished. */
export const RESCORE_POLL_MS = 3000

/**
 * After Publish: the latest photo of each viewpoint is scored again against the new version (the
 * reference photo or the spaces may have changed), so drivers see the new layout's states. Says so
 * while it runs, then what it found, with the photo to check.
 */
function RescoreStatus({ version, imageIds, onDone }: { version: number; imageIds: string[]; onDone: () => void }) {
  const [snaps, setSnaps] = useState<Record<string, SnapshotDetail>>({})
  const [failed, setFailed] = useState<string | null>(null)
  const done = imageIds.every((id) => snaps[id]?.finished)
  useEffect(() => {
    if (done || failed) return
    let cancelled = false
    const poll = async () => {
      try {
        const got = await Promise.all(imageIds.map((id) => api.get<SnapshotDetail>(`/admin/snapshots/${encodeURIComponent(id)}`)))
        if (!cancelled) setSnaps(Object.fromEntries(got.map((s) => [s.imageId, s])))
      } catch (e: unknown) {
        if (!cancelled) setFailed(errorMessage(e))
      }
    }
    const timer = window.setTimeout(() => void poll(), Object.keys(snaps).length === 0 ? 0 : RESCORE_POLL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [done, failed, imageIds, snaps])

  if (failed) {
    return (
      <p className="notice notice--warn mapping-notice" role="status">
        Couldn't follow the photo re-check for v{version}: {failed}. The Snapshots page shows it.
      </p>
    )
  }
  if (!done) {
    return (
      <p className="notice mapping-notice" role="status" data-testid="rescoring">
        Re-checking the latest photo against v{version} so drivers see the new layout. This takes a moment…
      </p>
    )
  }
  const all = imageIds.map((id) => snaps[id])
  const bad = all.find((s) => s.jobStatus !== 'COMPLETE')
  const count = (state: string) => all.reduce((t, s) => t + s.observations.filter((o) => o.state === state).length, 0)
  return (
    <p className={`notice ${bad ? 'notice--warn' : 'notice--ok'} mapping-notice`} role="status" data-testid="rescoring">
      {bad
        ? `The photo re-check for v${version} did not finish: ${bad.error ?? bad.jobStatus}.`
        : `Re-checked the latest photo against v${version}: ${count('FREE')} free, ${count('OCCUPIED')} occupied, ${count('UNKNOWN')} unknown.`}{' '}
      {all.map((s) => (
        <Link key={s.imageId} to={`/admin/snapshots/${encodeURIComponent(s.imageId)}/photo`}>
          View {s.viewId} photo
        </Link>
      ))}{' '}
      <button type="button" className="button button--sm" onClick={onDone}>
        Dismiss
      </button>
    </p>
  )
}

