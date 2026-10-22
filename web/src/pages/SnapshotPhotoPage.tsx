import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { CarBoxOut, ObservationOut, SnapshotDetail, SpaceState } from '../api/schemas'
import { StateIconSvg } from '../components/StateIcon'
import { CAR_CLASSES, classBreakdown } from '../lib/detections'
import { dateTime } from '../lib/relativeTime'
import { STATE_ORDER, visualFor } from '../lib/status'
import { useFetch } from '../lib/useFetch'

/** How often an unfinished job is re-fetched. */
export const POLL_MS = 3000

/** The states an observation can have (closures are applied later, on the status view). */
const PHOTO_STATES = STATE_ORDER.filter((s) => s !== 'CLOSED')

interface Size {
  w: number
  h: number
}

/** Admin check of one processed photo: aligned outlines and car boxes drawn on the upload. */
export function SnapshotPhotoPage() {
  const { imageId = '' } = useParams()
  // Keyed so every piece of per-photo state (size, load failure, kept URL) starts fresh.
  return <SnapshotPhoto key={imageId} imageId={imageId} />
}

function SnapshotPhoto({ imageId }: { imageId: string }) {
  const path = `/admin/snapshots/${encodeURIComponent(imageId)}`
  const snap = useFetch(() => api.get<SnapshotDetail>(path), path)
  const [showOutlines, setShowOutlines] = useState(true)
  const [size, setSize] = useState<Size | null>(null)
  const [photoFailed, setPhotoFailed] = useState(false)
  // Keep the first photo URL: a presigned URL changes on every poll and would reload the image.
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const data = snap.data
  if (data?.photoUrl && !photoUrl) setPhotoUrl(data.photoUrl)

  const pending = !!data && !data.finished && data.jobStatus !== 'EXPIRED'
  const { loading, reload } = snap
  useEffect(() => {
    if (!pending || loading) return
    const timer = setTimeout(reload, POLL_MS)
    return () => clearTimeout(timer)
  }, [pending, loading, reload])

  const complete = data?.jobStatus === 'COMPLETE'
  const available = !!photoUrl && data?.jobStatus !== 'EXPIRED' && !photoFailed
  // While a job is still running the photo may simply not be there yet; only a finished (or
  // expired) job without a usable photo is reported as missing.
  const settled = !!data && (data.finished || data.jobStatus === 'EXPIRED')

  return (
    <main className="page">
      <Link to="/admin" className="back-link">
        ← Admin
      </Link>
      <h1>
        {data ? `Photo: ${data.lotId} / ${data.viewId}, captured ${dateTime(data.captureTime)}` : 'Photo'}
      </h1>
      {snap.error && (
        <p className="notice notice--error" role="alert">
          {snap.error}
        </p>
      )}
      {!data && snap.loading && <p>Loading…</p>}
      {pending && data && (
        <p className="notice" role="status">
          {data.jobStatus === 'UPLOAD_PENDING' ? 'Waiting for the upload to complete…' : 'Processing…'}
        </p>
      )}
      {data?.jobStatus === 'FAILED' && data.finished && (
        <p className="notice notice--error" role="alert">
          Processing failed: {data.error ?? 'unknown error'}
        </p>
      )}
      {data && complete && <Counts observations={data.observations} boxes={data.detections} />}
      {data && complete && (
        <div className="photo-toggles" role="group" aria-label="Layers">
          <label>
            <input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} />
            Outlines
          </label>
        </div>
      )}
      {settled && !available && (
        <p className="notice notice--warn" role="status">
          Photo not available
        </p>
      )}
      {data && available && (
        <div className="photo-view">
          <img
            src={photoUrl}
            alt={`Uploaded photo of ${data.lotId} / ${data.viewId}`}
            className="photo-view__img"
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setPhotoFailed(true)}
          />
          {complete && size && size.w > 0 && size.h > 0 && (
            <Overlay
              size={size}
              observations={showOutlines ? data.observations : []}
              boxes={data.detections}
            />
          )}
        </div>
      )}
      {data && complete && <Legend />}
      {data && complete && <SpacesTable observations={data.observations} />}
      {data?.modelVersion && <p className="hint photo-model">Model: {data.modelVersion}</p>}
    </main>
  )
}

function Overlay({ size, observations, boxes }: { size: Size; observations: ObservationOut[]; boxes: CarBoxOut[] }) {
  const { w, h } = size
  const font = Math.max(10, w * 0.011)
  const halo = font * 0.18
  return (
    <svg
      className="photo-view__overlay"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${observations.length} outlines, ${boxes.length} detections`}
      data-testid="photo-overlay"
    >
      <g className="photo-outlines">
        {observations.map((o) => {
          if (!o.polygon || o.polygon.length === 0) return null
          const v = visualFor(o.state)
          const points = o.polygon.map(([x, y]) => `${x * w},${y * h}`).join(' ')
          const [lx, ly] = o.polygon[0]
          return (
            <g key={o.spaceId} className={`photo-space ${v.className}`} data-testid={`outline-${o.spaceId}`} data-state={o.state}>
              <title>{describe(o)}</title>
              <polygon points={points} className="photo-space__line" vectorEffect="non-scaling-stroke" />
              {/* Occupied draws a second, thin inner line: a double line that reads without colour. */}
              <polygon points={points} className="photo-space__inner" vectorEffect="non-scaling-stroke" />
              <text x={lx * w} y={ly * h - halo} fontSize={font} strokeWidth={halo} className="photo-label">
                {o.spaceId}
              </text>
            </g>
          )
        })}
      </g>
      <g className="photo-boxes">
        {boxes.map((b, i) => {
          const [x1, y1, x2, y2] = b.box
          const top = y1 * h
          return (
            <g
              key={i}
              className={`photo-box ${CAR_CLASSES.has(b.clsName) ? 'photo-box--car' : 'photo-box--other'}`}
              data-testid="detection-box"
              data-class={b.clsName}
            >
              <title>{`${b.clsName} ${b.conf.toFixed(2)}`}</title>
              <rect
                x={x1 * w}
                y={top}
                width={Math.max(0, (x2 - x1) * w)}
                height={Math.max(0, (y2 - y1) * h)}
                className="photo-box__rect"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )
        })}
      </g>
    </svg>
  )
}

const num = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2))

/** The per-space numbers as text, so they are not hover-only (keyboard and screen readers). */
function SpacesTable({ observations }: { observations: ObservationOut[] }) {
  return (
    <details className="photo-spaces">
      <summary>Spaces ({observations.length})</summary>
      <div className="photo-spaces__wrap">
        <table className="photo-spaces__table">
          <thead>
            <tr>
              <th scope="col">Space</th>
              <th scope="col">State</th>
              <th scope="col">ACPDS score</th>
              <th scope="col">Car overlap</th>
              <th scope="col">In frame</th>
            </tr>
          </thead>
          <tbody>
            {observations.map((o) => (
              <tr key={o.spaceId}>
                <th scope="row">{o.spaceId}</th>
                <td>{visualFor(o.state).label}</td>
                <td>{num(o.acpdsScore)}</td>
                <td>{num(o.carOverlap)}</td>
                <td>{o.inFrame ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function describe(o: ObservationOut): string {
  return [
    `${o.spaceId}: ${visualFor(o.state).label}`,
    `ACPDS ${num(o.acpdsScore)}`,
    `car overlap ${num(o.carOverlap)}`,
    o.inFrame ? 'in frame' : 'partly out of frame',
  ].join(', ')
}

function Counts({ observations, boxes }: { observations: ObservationOut[]; boxes: CarBoxOut[] }) {
  const count = (s: SpaceState) => observations.filter((o) => o.state === s).length
  return (
    <section className="summary" aria-label="Counts">
      <ul className="summary__counts">
        {PHOTO_STATES.map((s) => {
          const v = visualFor(s)
          return (
            <li key={s}>
              <StateIconSvg icon={v.icon} className={v.className} />
              <span>
                {count(s)} {v.label}
              </span>
            </li>
          )
        })}
        <li>
          <BoxSwatch />
          <span>YOLO: {boxes.length ? classBreakdown(boxes) : 'no detections'}</span>
        </li>
      </ul>
    </section>
  )
}

function Legend() {
  return (
    <section className="legend" aria-label="Legend">
      <h2>Legend</h2>
      <ul>
        {PHOTO_STATES.map((s) => {
          const v = visualFor(s)
          return (
            <li key={s}>
              <StateIconSvg icon={v.icon} className={v.className} />
              {v.label}
            </li>
          )
        })}
        <li>
          <BoxSwatch />
          Car box
        </li>
        <li>
          <BoxSwatch other />
          Other detection (not counted)
        </li>
      </ul>
      <p className="hint">
        Outlines differ by line as well as colour: solid is free, double is occupied, dotted is unknown. Detections are
        dashed boxes; only car, truck and bus count towards a space&apos;s car overlap. Hover an outline for its scores
        or a box for its class and confidence.
      </p>
    </section>
  )
}

function BoxSwatch({ other = false }: { other?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      className={`legend-swatch box-swatch ${other ? 'photo-box--other' : 'photo-box--car'}`}
    >
      <rect x="2" y="4" width="20" height="16" className="photo-box__rect" />
    </svg>
  )
}
