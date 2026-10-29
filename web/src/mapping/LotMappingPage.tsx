import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { LotDetail } from '../api/schemas'
import { useFetch } from '../lib/useFetch'
import { ReferencePhotoPanel } from './ReferencePhotoPanel'
import { SchematicEditor } from './SchematicEditor'
import type { DraftLayout, Issue, MappingSelection } from './types'
import { useDraftLayout } from './useDraftLayout'

/** "Draft based on v3", or "Not published yet" for a lot that was never published (brief §8.5). */
function draftBasis(draft: DraftLayout): string {
  return draft.basedOnVersion == null ? 'Not published yet' : `Draft based on v${draft.basedOnVersion}`
}

const NO_ISSUES: Issue[] = []

/** Lot mapping page (Sketch 5): schematic editor, reference photo panel, validation, Save. */
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
  // Unpublished lots are not in the public API, so their header falls back to the lot id.
  const detail = useFetch<LotDetail | null>(
    () => api.get<LotDetail>(`/lots/${encodeURIComponent(lotId)}`).catch(() => null),
    `mapping-lot:${lotId}`,
  )
  const lotName = detail.data?.lot.name ?? lotId

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
  const issues = NO_ISSUES // from the last validation, once Validate exists

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
    await save()
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
            className="button button--primary"
            onClick={onSave}
            disabled={!draft || saving || stale}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="button" disabled title="Coming soon">
            Validate
          </button>
          <button type="button" className="button" disabled title="Coming soon">
            Publish
          </button>
        </div>
      </div>

      <p className="hint mapping-save-state" aria-live="polite">
        {draft && !stale && (dirty ? 'Unsaved changes' : (savedNote ?? `Revision ${draft.revision}`))}
      </p>
      {stale && (
        <div className="notice notice--warn mapping-notice" role="alert">
          <span>{saveError}</span>
          <button type="button" className="button" onClick={reload}>
            Reload
          </button>
        </div>
      )}
      {!stale && saveError && (
        <p className="notice notice--error" role="alert">
          {saveError}
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
          <section className="mapping-panel mapping-validation" aria-label="Validation">
            <h2>Validation</h2>
            <p className="muted">Validation is coming soon.</p>
          </section>
        </>
      )}
    </main>
  )
}
