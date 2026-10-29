import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotDetail } from '../api/schemas'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'
import { classBreakdown } from '../lib/detections'
import { POLL_MS } from './SnapshotPhotoPage'

const URL = '/admin/snapshots/img-1/photo'
const API = 'GET /admin/snapshots/img-1'

const box = (x1: number, y1: number, x2: number, y2: number, conf = 0.9, clsName = 'car') => ({
  clsName, conf, box: [x1, y1, x2, y2],
})

const complete: SnapshotDetail = {
  imageId: 'img-1',
  lotId: 'drone-lot',
  viewId: 'V1',
  captureTime: '2026-10-21T10:00:00Z',
  jobStatus: 'COMPLETE',
  attempts: 1,
  finished: true,
  processingMs: 1234,
  modelVersion: 'acpds_yolo|acpds=abc|yolo=def',
  error: null,
  layoutVersion: 1,
  createdAt: '2026-10-21T10:00:00Z',
  photoUrl: '/api/_test/objects/raw/drone-lot/V1/img-1.jpg',
  detections: [
    box(0.1, 0.1, 0.2, 0.3), box(0.5, 0.5, 0.6, 0.7, 0.42), box(0.8, 0.8, 0.9, 0.95),
    box(0.3, 0.5, 0.4, 0.6, 0.66, 'cell phone'),
  ],
  observations: [
    {
      spaceId: 'B-17', state: 'OCCUPIED', acpdsScore: 0.97, carOverlap: 0.81, inFrame: true,
      polygon: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.3], [0.1, 0.3]],
    },
    {
      spaceId: 'B-18', state: 'UNKNOWN', acpdsScore: 0, carOverlap: 0.07, inFrame: true,
      polygon: [[0.3, 0.1], [0.4, 0.1], [0.4, 0.3], [0.3, 0.3]],
    },
    {
      spaceId: 'B-19', state: 'FREE', acpdsScore: 0.02, carOverlap: 0, inFrame: false,
      polygon: [[0.5, 0.1], [0.6, 0.1], [0.6, 0.3], [0.5, 0.3]],
    },
  ],
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

/** jsdom never loads images: give the photo a natural size and fire its load event. */
function loadPhoto(width = 4000, height = 3000) {
  const img = screen.getByRole('img', { name: /Uploaded photo of drone-lot/ }) as HTMLImageElement
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
  fireEvent.load(img)
  return img
}

describe('snapshot photo page', () => {
  it('draws one outline per observation and one box per detection on the photo', async () => {
    mockFetch({ [API]: { body: complete } })
    renderApp(URL, ADMIN)
    expect(await screen.findByRole('heading', { name: /Photo: drone-lot \/ V1, captured Oct 21/ })).toBeInTheDocument()
    const img = loadPhoto()
    expect(img).toHaveAttribute('src', complete.photoUrl)

    const overlay = screen.getByTestId('photo-overlay')
    expect(overlay).toHaveAttribute('viewBox', '0 0 4000 3000')
    expect(overlay.querySelectorAll('polygon.photo-space__line')).toHaveLength(3)
    expect(overlay.querySelectorAll('rect.photo-box__rect')).toHaveLength(4)

    const b17 = screen.getByTestId('outline-B-17')
    expect(b17).toHaveClass('space--occupied')
    expect(b17.querySelector('polygon')).toHaveAttribute('points', '400,300 800,300 800,900 400,900')
    expect(within(b17).getByText('B-17')).toBeInTheDocument()
    expect(screen.getByTestId('outline-B-18').querySelector('title')).toHaveTextContent(
      'B-18: Unknown, ACPDS 0.00, car overlap 0.07, in frame',
    )
    expect(screen.getByTestId('outline-B-19').querySelector('title')).toHaveTextContent('partly out of frame')
    expect(overlay.querySelectorAll('text.photo-box__label')).toHaveLength(0)
    const titles = Array.from(overlay.querySelectorAll('[data-testid="detection-box"] title'), (t) => t.textContent)
    expect(titles).toEqual(['car 0.90', 'car 0.42', 'car 0.90', 'cell phone 0.66'])
    // A non-car class is drawn, labelled with its class, and styled apart from cars.
    const phone = overlay.querySelector('[data-class="cell phone"]')
    expect(phone).toHaveClass('photo-box--other')
    expect(phone).toHaveTextContent('cell phone 0.66')
    expect(overlay.querySelectorAll('.photo-box--car')).toHaveLength(3)

    const counts = screen.getByRole('region', { name: 'Counts' })
    expect(counts).toHaveTextContent('1 Free')
    expect(counts).toHaveTextContent('1 Occupied')
    expect(counts).toHaveTextContent('1 Unknown')
    expect(counts).toHaveTextContent('YOLO: 3 car, 1 cell phone')
    const legend = screen.getByRole('region', { name: 'Legend' })
    expect(legend).toHaveTextContent('Car box')
    expect(legend).toHaveTextContent('Other detection (not counted)')
    expect(screen.getByText(/Model: acpds_yolo/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Admin' })).toHaveAttribute('href', '/admin')
  })

  it('lists every observation in a collapsible spaces table', async () => {
    mockFetch({ [API]: { body: complete } })
    renderApp(URL, ADMIN)
    const summary = await screen.findByText('Spaces (3)')
    expect(summary.closest('details')).not.toHaveAttribute('open')
    await userEvent.setup().click(summary)
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((r) => Array.from(r.querySelectorAll('th, td'), (c) => c.textContent))).toEqual([
      ['B-17', 'Occupied', '0.97', '0.81', 'Yes'],
      ['B-18', 'Unknown', '0.00', '0.07', 'Yes'],
      ['B-19', 'Free', '0.02', '0.00', 'No'],
    ])
  })

  it('always draws detection boxes and hides outlines with their toggle', async () => {
    mockFetch({ [API]: { body: complete } })
    renderApp(URL, ADMIN)
    await screen.findByRole('heading', { name: /Photo: drone-lot/ })
    loadPhoto()
    const user = userEvent.setup()
    const overlay = () => screen.getByTestId('photo-overlay')

    expect(screen.queryByRole('checkbox', { name: 'Detections' })).not.toBeInTheDocument()
    expect(overlay().querySelectorAll('rect.photo-box__rect')).toHaveLength(4)

    await user.click(screen.getByRole('checkbox', { name: 'Outlines' }))
    expect(overlay().querySelectorAll('polygon')).toHaveLength(0)
    expect(overlay().querySelectorAll('rect.photo-box__rect')).toHaveLength(4)
  })

  it('shows Processing… and polls until the job finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const processing = { ...complete, jobStatus: 'PROCESSING' as const, finished: false, observations: [], detections: [] }
    let calls = 0
    mockFetch({ [API]: () => ({ body: ++calls < 2 ? processing : complete }) })
    renderApp(URL, ADMIN)
    expect(await screen.findByText('Processing…')).toBeInTheDocument()
    expect(screen.queryByTestId('photo-overlay')).not.toBeInTheDocument()
    expect(screen.queryByText('Photo not available')).not.toBeInTheDocument()
    loadPhoto()
    expect(screen.queryByTestId('photo-overlay')).not.toBeInTheDocument() // no overlays yet

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS)
    })
    expect(await screen.findByRole('region', { name: 'Counts' })).toHaveTextContent('YOLO: 3 car, 1 cell phone')
    expect(screen.queryByText('Processing…')).not.toBeInTheDocument()
    expect(calls).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    })
    expect(calls).toBe(2) // finished: polling stopped
  })

  it('shows a failed job’s error and the photo without overlays', async () => {
    const failed = {
      ...complete, jobStatus: 'FAILED' as const, error: 'Too few matches', observations: [], detections: [], modelVersion: null,
    }
    mockFetch({ [API]: { body: failed } })
    renderApp(URL, ADMIN)
    expect(await screen.findByRole('alert')).toHaveTextContent('Processing failed: Too few matches')
    loadPhoto()
    expect(screen.queryByTestId('photo-overlay')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Detections' })).not.toBeInTheDocument()
  })

  it('says the photo is not available when it is missing or expired', async () => {
    const expired = {
      ...complete, jobStatus: 'EXPIRED' as const, finished: false, photoUrl: null, observations: [], detections: [],
    }
    const fetchMock = mockFetch({ [API]: { body: expired } })
    renderApp(URL, ADMIN)
    expect(await screen.findByText('Photo not available')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Uploaded photo/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Processing…')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/admin/snapshots/img-1')).toHaveLength(1)
  })

  it('does not report a missing photo while the job is still queued', async () => {
    const queued = { ...complete, jobStatus: 'QUEUED' as const, finished: false, photoUrl: null, observations: [], detections: [] }
    mockFetch({ [API]: { body: queued } })
    renderApp(URL, ADMIN)
    expect(await screen.findByText('Processing…')).toBeInTheDocument()
    expect(screen.queryByText('Photo not available')).not.toBeInTheDocument()
  })

  it('says the photo is not available when the image fails to load', async () => {
    mockFetch({ [API]: { body: complete } })
    renderApp(URL, ADMIN)
    fireEvent.error(await screen.findByRole('img', { name: /Uploaded photo/ }))
    expect(await screen.findByText('Photo not available')).toBeInTheDocument()
  })
})

describe('classBreakdown', () => {
  it('counts detections per class, most frequent first', () => {
    const phones = Array.from({ length: 3 }, () => box(0, 0, 1, 1, 0.5, 'cell phone'))
    expect(classBreakdown([box(0, 0, 1, 1), ...phones, box(0, 0, 1, 1, 0.5, 'truck')])).toBe(
      '3 cell phone, 1 car, 1 truck',
    )
    expect(classBreakdown([])).toBe('')
  })
})
