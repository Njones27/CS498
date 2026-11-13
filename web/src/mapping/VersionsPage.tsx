import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, errorMessage } from '../api/client'
import type { LotDetail } from '../api/schemas'
import { Main } from '../components/Main'
import { dateTime } from '../lib/relativeTime'
import { useFetch } from '../lib/useFetch'
import type { MappingLocationState } from './LotMappingPage'
import type { DraftLayout, LayoutVersionOut } from './types'

/** US-09 #6 and #7: published versions, newest first, each with Restore. */
export function VersionsPage() {
  const { lotId = '' } = useParams()
  const navigate = useNavigate()
  const base = `/admin/lots/${encodeURIComponent(lotId)}`
  const versions = useFetch<LayoutVersionOut[]>(() => api.get<LayoutVersionOut[]>(`${base}/layout/versions`), `versions:${lotId}`)
  const detail = useFetch<LotDetail | null>(
    () => api.get<LotDetail>(`/lots/${encodeURIComponent(lotId)}`).catch(() => null),
    `versions-lot:${lotId}`,
  )
  const lotName = detail.data?.lot.name ?? lotId
  const live = detail.data?.layout.version ?? null
  const [restoring, setRestoring] = useState<number | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  // The version waiting for a yes. Asked in the page, not with window.confirm: embedded browsers
  // cancel that without showing it.
  const [confirming, setConfirming] = useState<number | null>(null)
  const questionId = useId()
  // Cancelled (or closed with Escape): focus goes back to the Restore button that asked.
  const restoreButtons = useRef(new Map<number, HTMLButtonElement>())
  const backTo = useRef<number | null>(null)
  useEffect(() => {
    if (confirming != null || backTo.current == null) return
    restoreButtons.current.get(backTo.current)?.focus()
    backTo.current = null
  }, [confirming])
  const cancel = () => {
    backTo.current = confirming
    setConfirming(null)
  }

  async function onRestore(version: number) {
    setConfirming(null)
    setRestoring(version)
    setRestoreError(null)
    try {
      await api.post<DraftLayout>(`${base}/layout/versions/${version}/restore`)
      const state: MappingLocationState = { restoredFrom: version }
      navigate(`${base}/map`, { state })
    } catch (e: unknown) {
      setRestoreError(errorMessage(e))
      setRestoring(null)
    }
  }

  const rows = versions.data ?? []
  return (
    <Main className="page versions-page">
      <Link to={`${base}/map`} className="back-link">
        ← Lot Mapping
      </Link>
      <h1>
        Versions <span className="mapping-head__part">· {lotName}</span>
      </h1>
      {restoreError && (
        <p className="notice notice--error" role="alert">
          {restoreError}
        </p>
      )}
      {versions.error && (
        <p className="notice notice--error" role="alert">
          {versions.error}
        </p>
      )}
      {confirming != null && (
        <div
          className="notice notice--warn"
          role="group"
          aria-labelledby={questionId}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel()
          }}
        >
          <span id={questionId}>Replace the draft with v{confirming}? Draft changes that are not published will be lost.</span>{' '}
          <button
            type="button"
            className="button button--primary button--sm"
            autoFocus
            aria-describedby={questionId}
            onClick={() => void onRestore(confirming)}
          >
            Replace the draft
          </button>{' '}
          <button type="button" className="button button--ghost button--sm" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      {versions.loading && !versions.data && <p className="muted">Loading versions…</p>}
      {versions.data && rows.length === 0 && <p className="muted">Nothing published yet.</p>}
      {rows.length > 0 && (
        <div className="versions-table-wrap">
          <table className="versions-table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Published by</th>
                <th scope="col">Published</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.version}>
                  <td>
                    v{v.version}
                    {v.version === live && <span className="versions-live"> Live</span>}
                  </td>
                  <td>{v.publishedBy}</td>
                  <td>
                    <time dateTime={v.publishedAt}>{dateTime(v.publishedAt)}</time>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      ref={(el) => {
                        if (el) restoreButtons.current.set(v.version, el)
                        else restoreButtons.current.delete(v.version)
                      }}
                      onClick={() => setConfirming(v.version)}
                      disabled={restoring != null}
                      aria-label={`Restore v${v.version}`}
                    >
                      {restoring === v.version ? 'Restoring…' : 'Restore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Main>
  )
}
