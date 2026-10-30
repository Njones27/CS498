import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api, errorMessage } from '../api/client'
import type { LotDetail } from '../api/schemas'
import { useFetch } from '../lib/useFetch'
import { ReferencePhotoPanel } from './ReferencePhotoPanel'
import { SchematicEditor } from './SchematicEditor'
import type { DraftLayout, Issue, LayoutVersionOut, MappingSelection, ValidationReport } from './types'
import { draftPath, useDraftLayout } from './useDraftLayout'
import { ValidationPanel } from './ValidationPanel'

/** "Draft based on v3", or "Not published yet" for a lot that was never published (brief §8.5). */
function draftBasis(draft: DraftLayout): string {
  return draft.basedOnVersion == null ? 'Not published yet' : `Draft based on v${draft.basedOnVersion}`
}

const NO_ISSUES: Issue[] = []

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
  const [actionError, setActionError] = useState<string | null>(null)
  // A publish refused with stale_revision: like a stale save, the draft must be reloaded.
  const [publishStale, setPublishStale] = useState<string | null>(null)

  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null)
  const [pickedViewId, setPickedViewId] = useState<string | null>(null)
  const viewpoints = draft?.viewpoints ?? []
  const viewId = viewpoints.some((v) => v.viewId === pickedViewId) ? pickedViewId : (viewpoints[0]?.viewId ?? null)
  const selection: MappingSelection = {
    selectedSpaceId,
    onSelectSpace: setSelectedSpaceId,
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
    <main className="page mapping-page">
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
            <SchematicEditor {...selection} draft={draft} onChange={setDraft} issues={issues} />
            <ReferencePhotoPanel
              {...selection}
              lotId={lotId}
              draft={draft}
              viewId={viewId}
              onViewChange={setPickedViewId}
              onChange={setDraft}
              onReferenceUploaded={() => void refreshReferenceImages()}
              issues={issues}
              onSave={save}
            />
          </div>
          <ValidationPanel report={report} draft={draft} onSelectSpace={setSelectedSpaceId} />
        </>
      )}
    </main>
  )
}
