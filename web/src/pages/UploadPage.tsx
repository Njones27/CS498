import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api, errorMessage } from '../api/client'
import type {
  LotDetail,
  LotListItem,
  UploadCompleteResponse,
  UploadRequest,
  UploadSlot,
} from '../api/schemas'
import { readCaptureTime } from '../lib/exif'
import { putFile } from '../lib/putFile'
import { shortDate, toDateTimeLocal } from '../lib/relativeTime'
import { sha256Hex } from '../lib/sha256'
import {
  FUTURE_TIME_MESSAGE,
  isAcceptedType,
  parseLocalDateTime,
  validateFile,
} from '../lib/uploadValidation'
import { useFetch } from '../lib/useFetch'

/** localStorage key shared with the admin lot picker (US-16 #3). */
export const ADMIN_LOT_KEY = 'parking.admin.lotId'

function rememberedLot(): string {
  try {
    return localStorage.getItem(ADMIN_LOT_KEY) ?? ''
  } catch {
    return ''
  }
}

type Outcome =
  | { kind: 'success'; imageId: string }
  | { kind: 'duplicate'; uploadedAt: string | null | undefined; imageId: string | null | undefined }
  | { kind: 'error'; message: string }

/** US-04 / US-05: upload a lot photo with its capture time. */
export function UploadPage() {
  const lots = useFetch(() => api.get<LotListItem[]>('/lots'), 'lots')
  const [storedLotId, setLotId] = useState(rememberedLot)
  const lotId = lots.data && !lots.data.some((l) => l.lotId === storedLotId) ? '' : storedLotId
  const detail = useFetch<LotDetail | null>(
    () => (lotId ? api.get<LotDetail>(`/lots/${encodeURIComponent(lotId)}`) : Promise.resolve(null)),
    `detail:${lotId}`,
  )
  const [chosenViewId, setViewId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [captureTime, setCaptureTime] = useState('')
  const [timeError, setTimeError] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  // Bumped on every file change so a slow EXIF read for an earlier file is discarded.
  const fileSeq = useRef(0)

  // Default to a lot's only viewpoint, but only from the detail of the lot actually selected.
  const viewpoints = detail.data && detail.data.lot.lotId === lotId ? detail.data.viewpoints : []
  const viewId =
    viewpoints.length === 1
      ? viewpoints[0].viewId
      : viewpoints.some((v) => v.viewId === chosenViewId)
        ? chosenViewId
        : ''

  function onLotChange(e: ChangeEvent<HTMLSelectElement>) {
    setLotId(e.target.value)
    setViewId('')
    try {
      localStorage.setItem(ADMIN_LOT_KEY, e.target.value)
    } catch {
      // storage unavailable; the picker just will not remember
    }
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    const seq = ++fileSeq.current
    setOutcome(null)
    setProgress(null)
    setTimeError(null)
    setCaptureTime('')
    if (!f) {
      setFile(null)
      setFileError(null)
      return
    }
    const err = validateFile(f)
    setFileError(err)
    setFile(err ? null : f)
    if (err) return
    const taken = await readCaptureTime(f)
    if (seq !== fileSeq.current) return
    setCaptureTime(taken ? toDateTimeLocal(taken) : '')
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy || !file || !lotId || !viewId) return
    const when = parseLocalDateTime(captureTime)
    if (!when) return
    if (when.getTime() > Date.now()) {
      setTimeError(FUTURE_TIME_MESSAGE)
      return
    }
    setTimeError(null)
    setOutcome(null)
    setBusy(true)
    setProgress(0)
    try {
      if (!isAcceptedType(file.type)) throw new Error('Only JPEG or PNG photos are accepted')
      const body: UploadRequest = {
        lotId,
        viewId,
        captureTime: when.toISOString(),
        sha256: await sha256Hex(file),
        contentType: file.type,
        sizeBytes: file.size,
      }
      const slot = await api.post<UploadSlot>('/admin/uploads', body)
      await putFile(slot.uploadUrl, file, setProgress)
      await api.post<UploadCompleteResponse>(`/admin/uploads/${encodeURIComponent(slot.imageId)}/complete`)
      setOutcome({ kind: 'success', imageId: slot.imageId })
    } catch (err) {
      setProgress(null)
      if (err instanceof ApiError && err.status === 409 && err.code === 'duplicate') {
        setOutcome({ kind: 'duplicate', uploadedAt: err.uploadedAt, imageId: err.originalImageId })
      } else {
        setOutcome({ kind: 'error', message: errorMessage(err) })
      }
    } finally {
      setBusy(false)
    }
  }

  const canUpload = !busy && !!file && !!lotId && !!viewId && !!captureTime

  return (
    <main className="page page--narrow">
      <Link to="/admin" className="back-link">
        ← Admin
      </Link>
      <h1>Upload photo</h1>
      {lots.error && (
        <p className="notice notice--error" role="alert">
          {lots.error}
        </p>
      )}
      <form className="form" onSubmit={onSubmit} noValidate>
        {/* Locked while uploading so the in-flight result cannot land against changed inputs. */}
        <fieldset className="form__fields" disabled={busy}>
          <label>
            Lot
            <select value={lotId} onChange={onLotChange} required>
              <option value="">Choose a lot</option>
              {lots.data?.map((l) => (
                <option key={l.lotId} value={l.lotId}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Viewpoint
            <select value={viewId} onChange={(e) => setViewId(e.target.value)} disabled={!lotId} required>
              <option value="">Choose a viewpoint</option>
              {viewpoints.map((v) => (
                <option key={v.viewId} value={v.viewId}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Photo
            <input type="file" accept="image/jpeg,image/png" onChange={onFileChange} />
          </label>
          {fileError && (
            <p className="notice notice--error" role="alert">
              {fileError}
            </p>
          )}
          <label>
            Capture time
            <input
              type="datetime-local"
              step="1"
              value={captureTime}
              onChange={(e) => {
                setCaptureTime(e.target.value)
                setTimeError(null)
              }}
            />
          </label>
          {file && !captureTime && <p className="hint">This photo has no capture time. Enter when it was taken.</p>}
          {timeError && (
            <p className="notice notice--error" role="alert">
              {timeError}
            </p>
          )}
          {progress !== null && (
            <progress className="progress" value={Math.round(progress * 100)} max={100} aria-label="Upload progress">
              {Math.round(progress * 100)}%
            </progress>
          )}
          <button type="submit" className="button button--primary" disabled={!canUpload}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </fieldset>
      </form>
      {outcome?.kind === 'success' && (
        <p className="notice notice--ok" role="status">
          <span>Photo queued for processing</span>{' '}
          <Link to={`/admin/snapshots/${encodeURIComponent(outcome.imageId)}/photo`}>View the photo with results</Link>
        </p>
      )}
      {outcome?.kind === 'duplicate' && (
        <p className="notice notice--warn" role="alert">
          This photo was already uploaded on {outcome.uploadedAt ? shortDate(outcome.uploadedAt) : 'an earlier date'}.{' '}
          {outcome.imageId && <Link to={`/admin/snapshots#${encodeURIComponent(outcome.imageId)}`}>View the original</Link>}
        </p>
      )}
      {outcome?.kind === 'error' && (
        <p className="notice notice--error" role="alert">
          {outcome.message}
        </p>
      )}
    </main>
  )
}
