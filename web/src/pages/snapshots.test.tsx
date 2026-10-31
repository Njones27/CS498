import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminLotOut, SnapshotOut } from '../api/lotsAdmin'
import type { LotDetail, SnapshotDetail } from '../api/schemas'
import { canRetry, modelName, processingTime } from '../lib/snapshots'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'

const LIST = 'GET /admin/snapshots?lotId=test-lot'
const MODEL = 'acpds_yolo|acpds=96901e9003a3|yolo=401cea9ab23a|overlap=box|low=0.3|high=0.7'

const lots: AdminLotOut[] = [
  {
    lotId: 'test-lot', name: 'Test Lot', location: 'x', staleAfterMinutes: 30, published: true, layoutVersion: 3,
    createdAt: '2026-10-01T12:00:00Z',
  },
]
const lotDetail: LotDetail = {
  lot: { lotId: 'test-lot', name: 'Test Lot', location: 'x', staleAfterMinutes: 30 },
  viewpoints: [{ viewId: 'V1', name: 'North' }],
  layout: {
    version: 3,
    schematic: { width: 1000, height: 600 },
    spaces: [
      { spaceId: 'sp_a01', label: 'A-01', type: 'STANDARD', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { spaceId: 'sp_a02', label: 'A-02', type: 'STANDARD', rect: { x: 20, y: 0, w: 10, h: 10 } },
    ],
  },
}

const row = (imageId: string, over: Partial<SnapshotOut> = {}): SnapshotOut => ({
  imageId,
  lotId: 'test-lot',
  viewId: 'V1',
  captureTime: '2026-10-21T14:05:00Z',
  jobStatus: 'COMPLETE',
  attempts: 1,
  finished: true,
  processingMs: 18_000,
  modelVersion: MODEL,
  error: null,
  layoutVersion: 3,
  createdAt: '2026-10-21T14:06:00Z',
  ...over,
})

// Sketch 4, newest capture first (the API sorts).
const complete = row('img-1405')
const processing = row('img-1350', {
  viewId: 'V2', captureTime: '2026-10-21T13:50:00Z', jobStatus: 'PROCESSING', finished: false, processingMs: null,
  layoutVersion: null,
})
const failed = row('img-1335', {
  captureTime: '2026-10-21T13:35:00Z', jobStatus: 'FAILED', processingMs: null, error: 'Too few matches',
  layoutVersion: null,
})
const queued = row('img-1320', {
  captureTime: '2026-10-21T13:20:00Z', jobStatus: 'QUEUED', finished: false, attempts: 0, processingMs: null,
  modelVersion: null, layoutVersion: null,
})
const SKETCH = [complete, processing, failed, queued]

const detail: SnapshotDetail = {
  ...complete,
  photoUrl: null,
  detections: [],
  observations: [
    { spaceId: 'sp_a02', state: 'FREE', acpdsScore: 0.12, carOverlap: 0, inFrame: true, polygon: null },
    { spaceId: 'sp_a01', state: 'OCCUPIED', acpdsScore: 0.91, carOverlap: 0.62, inFrame: true, polygon: null },
    { spaceId: 'sp_gone', state: 'UNKNOWN', acpdsScore: null, carOverlap: 0.05, inFrame: false, polygon: null },
  ],
}

beforeEach(() => {
  localStorage.setItem('parking.admin.lotId', 'test-lot')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

function setup(list: SnapshotOut[] | Parameters<typeof mockFetch>[0][string] = SKETCH, routes: Parameters<typeof mockFetch>[0] = {}, path = '/admin/snapshots') {
  const fetchMock = mockFetch({
    'GET /admin/lots': { body: lots },
    'GET /lots/test-lot': { body: lotDetail },
    [LIST]: Array.isArray(list) ? { body: list } : list,
    ...routes,
  })
  renderApp(path, ADMIN)
  return { fetchMock, user: userEvent.setup() }
}

const rowOf = (imageId: string) => screen.findByTestId(`snapshot-${imageId}`)
const cells = (tr: HTMLElement) => within(tr).getAllByRole('cell').map((c) => c.textContent)
const listCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([u]) => String(u) === '/api/admin/snapshots?lotId=test-lot')

describe('Snapshots page (US-06)', () => {
  it('US-06 #1: lists snapshots newest capture first with view, state, time, model and error', async () => {
    setup()
    await rowOf('img-1405')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Snapshots Test Lot')
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Captured', 'View', 'State', 'Time', 'Model', 'Error', 'Actions',
    ])
    const ids = screen.getAllByTestId(/^snapshot-img-/).map((tr) => tr.dataset.testid)
    expect(ids).toEqual(['snapshot-img-1405', 'snapshot-img-1350', 'snapshot-img-1335', 'snapshot-img-1320'])

    const [, view, state, time, model, error] = cells(await rowOf('img-1405'))
    expect([view, state, time, model, error]).toEqual(['V1', 'COMPLETE', '18 s', 'acpds_yolo', '-'])
    expect(within(await rowOf('img-1405')).getByText('acpds_yolo')).toHaveAttribute('title', MODEL)
    expect(cells(await rowOf('img-1350')).slice(1, 4)).toEqual(['V2', 'PROCESSING', '-'])
    expect(cells(await rowOf('img-1320'))[4]).toBe('-')
  })

  it('US-06 #2: a failed row shows FAILED and "Too few matches"', async () => {
    setup()
    const tr = await rowOf('img-1335')
    expect(within(tr).getByText('FAILED')).toBeInTheDocument()
    expect(within(tr).getByText('Too few matches')).toBeInTheDocument()
  })

  it('US-06 #3: pressing Retry makes the row show QUEUED', async () => {
    const { fetchMock, user } = setup(SKETCH, {
      'POST /admin/snapshots/img-1335/retry': {
        body: { ...failed, jobStatus: 'QUEUED', finished: false, attempts: 0, error: null },
      },
    })
    const tr = await rowOf('img-1335')
    await user.click(within(tr).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(within(tr).getByText('QUEUED')).toBeInTheDocument())
    expect(within(tr).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(within(tr).queryByText('Too few matches')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('shows a refused retry inline on its row', async () => {
    const { user } = setup(SKETCH, {
      'POST /admin/snapshots/img-1335/retry': {
        status: 409,
        body: { error: 'not_retryable', message: 'Only finished, failed jobs can be retried' },
      },
    })
    const tr = await rowOf('img-1335')
    await user.click(within(tr).getByRole('button', { name: 'Retry' }))
    expect(await within(tr).findByRole('alert')).toHaveTextContent('Only finished, failed jobs can be retried')
    expect(within(tr).getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('US-06 #4: no Retry button for COMPLETE, QUEUED or PROCESSING', async () => {
    const stillRetrying = row('img-flaky', { jobStatus: 'FAILED', finished: false, error: 'flaky' })
    setup([...SKETCH, stillRetrying])
    for (const id of ['img-1405', 'img-1350', 'img-1320', 'img-flaky']) {
      expect(within(await rowOf(id)).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    }
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
  })

  it('US-06 #5: "Failed after 3 attempts" still shows Retry', async () => {
    setup([row('img-x', { jobStatus: 'FAILED', attempts: 3, error: 'Failed after 3 attempts', processingMs: null })])
    const tr = await rowOf('img-x')
    expect(within(tr).getByText('FAILED')).toBeInTheDocument()
    expect(within(tr).getByText('Failed after 3 attempts')).toBeInTheDocument()
    expect(within(tr).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('US-06 #6: the detail shows per-space state, confidence, overlap and layout version', async () => {
    const { user } = setup(SKETCH, { 'GET /admin/snapshots/img-1405': { body: detail } })
    await user.click(await rowOf('img-1405'))
    const panel = await screen.findByRole('region', { name: 'Snapshot detail' })
    expect(await within(panel).findByText('Processed with layout v3')).toBeInTheDocument()
    expect(within(panel).getByText(MODEL)).toBeInTheDocument()
    expect(within(panel).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Space', 'State', 'Confidence', 'Car overlap', 'In frame',
    ])
    const spaces = within(panel).getAllByRole('row').slice(1).map((tr) => [
      within(tr).getByRole('rowheader').textContent,
      // The state cell's icon is aria-hidden; read its text label only.
      ...within(tr).getAllByRole('cell').map((c) => (c.querySelector('.snapshot-detail__state')?.lastChild ?? c).textContent),
    ])
    expect(spaces).toEqual([
      ['A-01', 'Occupied', '0.91', '0.62', 'Yes'],
      ['A-02', 'Free', '0.12', '0.00', 'Yes'],
      ['sp_gone', 'Unknown', '-', '0.05', 'No'],
    ])
    expect(within(panel).getByRole('link', { name: 'View photo with outlines' })).toHaveAttribute(
      'href',
      '/admin/snapshots/img-1405/photo',
    )
    await user.click(within(panel).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('region', { name: 'Snapshot detail' })).not.toBeInTheDocument()
  })

  it('the detail opens from the keyboard via the capture time button', async () => {
    const { user } = setup(SKETCH, { 'GET /admin/snapshots/img-1405': { body: detail } })
    const button = within(await rowOf('img-1405')).getByRole('button', { expanded: false })
    button.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Processed with layout v3')).toBeInTheDocument()
  })

  it('shows "Expired" for an upload that never arrived (US-04 #7)', async () => {
    setup([row('img-old', { jobStatus: 'EXPIRED', finished: false, processingMs: null, modelVersion: null })])
    expect(within(await rowOf('img-old')).getByText('Expired')).toBeInTheDocument()
  })

  it('polls every 5 s while a job is pending and stops when none are', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let n = 0
    const { fetchMock } = setup(() => {
      n += 1
      return { body: n === 1 ? [queued] : [{ ...queued, jobStatus: 'COMPLETE', finished: true, processingMs: 4200 }] }
    })
    expect(within(await rowOf('img-1320')).getByText('QUEUED')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('every 5 s')
    await act(() => vi.advanceTimersByTimeAsync(5000))
    await waitFor(async () => expect(within(await rowOf('img-1320')).getByText('COMPLETE')).toBeInTheDocument())
    expect(within(await rowOf('img-1320')).getByText('4.2 s')).toBeInTheDocument()
    const after = listCalls(fetchMock).length
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(listCalls(fetchMock)).toHaveLength(after)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not poll when every job is finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { fetchMock } = setup([complete, failed])
    await rowOf('img-1405')
    await act(() => vi.advanceTimersByTimeAsync(12_000))
    expect(listCalls(fetchMock)).toHaveLength(1)
  })

  it('/admin/snapshots#<imageId> scrolls to and highlights that row and opens its detail', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    setup(SKETCH, { 'GET /admin/snapshots/img-1335': { body: { ...detail, ...failed } } }, '/admin/snapshots#img-1335')
    const tr = await rowOf('img-1335')
    expect(tr).toHaveClass('snapshot-row--highlight')
    expect((await rowOf('img-1405')).className).not.toContain('highlight')
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1))
    expect(scroll.mock.contexts[0]).toBe(tr)
    expect(await screen.findByRole('region', { name: 'Snapshot detail' })).toHaveTextContent('Too few matches')
  })

  it("another lot's photo in the #<imageId> link shows a notice, not its detail", async () => {
    const elsewhere = { ...detail, imageId: 'img-north', lotId: 'north-lot' }
    setup(
      SKETCH,
      {
        'GET /admin/lots': {
          body: [...lots, { ...lots[0], lotId: 'north-lot', name: 'North Lot' }],
        },
        'GET /admin/snapshots/img-north': { body: elsewhere },
      },
      '/admin/snapshots#img-north',
    )
    const panel = await screen.findByRole('region', { name: 'Snapshot detail' })
    expect(await within(panel).findByText('This photo belongs to North Lot, not Test Lot. Pick that lot to see it.')).toBeInTheDocument()
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument()
    expect(within(panel).queryByRole('link', { name: 'View photo with outlines' })).not.toBeInTheDocument()
  })

  it('labels the same photo re-scored after a publish', async () => {
    setup([row('img-rescore', { layoutVersion: 4, rescoreOf: 'img-1405' }), complete])
    expect(cells(await rowOf('img-rescore'))[1]).toBe('V1 · Re-scored for layout v4')
    expect(cells(await rowOf('img-1405'))[1]).toBe('V1')
  })

  it('says when a lot has no photos yet', async () => {
    setup([])
    expect(await screen.findByText(/No photos uploaded for this lot yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Upload a photo' })).toHaveAttribute('href', '/admin/upload')
  })

  it('stays behind the admin guard', () => {
    mockFetch({})
    renderApp('/admin/snapshots#img-0')
    expect(screen.getByTestId('location')).toHaveTextContent('/signin?next=%2Fadmin%2Fsnapshots%23img-0')
  })
})

describe('snapshot helpers', () => {
  it('formats processing time', () => {
    expect(processingTime(null)).toBe('-')
    expect(processingTime(18_000)).toBe('18 s')
    expect(processingTime(18_499)).toBe('18 s')
    expect(processingTime(600)).toBe('0.6 s')
    expect(processingTime(4000)).toBe('4 s')
  })

  it('shows the scorer name before the first "|"', () => {
    expect(modelName(MODEL)).toBe('acpds_yolo')
    expect(modelName('stub-0')).toBe('stub-0')
    expect(modelName(null)).toBe('-')
  })

  it('allows Retry only for finished FAILED jobs', () => {
    expect(canRetry({ jobStatus: 'FAILED', finished: true })).toBe(true)
    expect(canRetry({ jobStatus: 'FAILED', finished: false })).toBe(false)
    for (const jobStatus of ['COMPLETE', 'QUEUED', 'PROCESSING', 'UPLOAD_PENDING', 'EXPIRED'] as const) {
      expect(canRetry({ jobStatus, finished: true })).toBe(false)
    }
  })
})
