import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { LotDetail } from '../api/schemas'
import { useFetch } from '../lib/useFetch'
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
  const { draft, loading, error, saving, saveError, stale, dirty, setDraft, save, reload, refreshReferenceImages } =
    useDraftLayout(lotId)
  // Unpublished lots are not in the public API, so their header falls back to the lot id.
  const detail = useFetch<LotDetail | null>(
    () => api.get<LotDetail>(`/lots/${encodeURIComponent(lotId)}`).catch(() => null),
    `mapping-lot:${lotId}`,
  )
  const lotName = detail.data?.lot.name ?? lotId
  const [savedNote, setSavedNote] = useState<string | null>(null)

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

  async function onSave() {
    setSavedNote(null)
    if (await save()) setSavedNote('Draft saved')
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
          <button type="button" className="button button--primary" onClick={onSave} disabled={!draft || saving || stale}>
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
            <ReferencePhotoPlaceholder
              {...selection}
              lotId={lotId}
              draft={draft}
              viewId={viewId}
              onViewChange={setPickedViewId}
              onChange={setDraft}
              onReferenceUploaded={() => void refreshReferenceImages()}
              issues={issues}
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

// Stand-in until Rylan's ReferencePhotoPanel lands. It takes the brief §4.4 props, so swapping
// in the real panel only changes the component name.

interface ReferencePanelProps extends MappingSelection {
  lotId: string
  draft: DraftLayout
  viewId: string | null
  onViewChange: (viewId: string) => void
  onChange: (next: DraftLayout) => void
  onReferenceUploaded: () => void
  issues: Issue[]
}

function ReferencePhotoPlaceholder(props: ReferencePanelProps) {
  const names = props.draft.viewpoints.map((v) => `${v.viewId} ${v.name}`).join(', ')
  return (
    <section className="mapping-panel" aria-label="Reference photo">
      <h2>Reference photo</h2>
      <p>{names || 'No viewpoints yet'}</p>
      <p className="muted">The reference photo panel is coming soon.</p>
    </section>
  )
}
