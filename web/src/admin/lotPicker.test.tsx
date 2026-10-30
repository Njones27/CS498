import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminLotOut, SnapshotOut } from '../api/lotsAdmin'
import type { LotDetail, LotListItem, LotStatusOut } from '../api/schemas'
import { draftFixture } from '../mapping/fixtures/kevin'
import { AGE_RANGE, NAME_REQUIRED } from '../pages/NewLotPage'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'
import { ADMIN_LOT_KEY, resolveLotId } from './adminLot'

const KEY = 'parking.admin.lotId'

const adminLot = (lotId: string, name: string, published = true): AdminLotOut => ({
  lotId,
  name,
  location: 'Campus',
  staleAfterMinutes: 30,
  published,
  layoutVersion: published ? 1 : null,
  createdAt: '2026-10-01T12:00:00Z',
})
const TEST_LOT = adminLot('test-lot', 'Test Lot')
const NORTH_LOT = adminLot('north-lot', 'North Lot')
const NEW_NORTH = adminLot('north-lot', 'North Lot', false)

const listItem = (lotId: string, name: string): LotListItem => ({
  lotId, name, location: 'x', staleAfterMinutes: 30, layoutVersion: 1,
  summary: { free: 0, occupied: 0, unknown: 0, closed: 0, total: 0, openPercent: null, hasRecentData: false, isStale: false },
})
const lotDetail = (lotId: string, name: string, view: string): LotDetail => ({
  lot: { lotId, name, location: 'x', staleAfterMinutes: 30 },
  viewpoints: [{ viewId: 'V1', name: view }],
  layout: { version: 1, schematic: { width: 1000, height: 600 }, spaces: [] },
})
const snapshot = (imageId: string, lotId: string): SnapshotOut => ({
  imageId, lotId, viewId: 'V1', captureTime: '2026-10-21T14:05:00Z', jobStatus: 'COMPLETE', attempts: 1,
  finished: true, processingMs: 18_000, modelVersion: 'stub-0', error: null, layoutVersion: 1,
  createdAt: '2026-10-21T14:06:00Z',
})

beforeEach(() => {
  localStorage.setItem(KEY, 'test-lot')
})
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

const picker = () => screen.findByRole('combobox', { name: 'Lot picker' }) as Promise<HTMLSelectElement>
const calls = (fetchMock: ReturnType<typeof mockFetch>, method: string, path: string) =>
  fetchMock.mock.calls.filter(([u, init]) => (init?.method ?? 'GET') === method && String(u) === `/api${path}`)

describe('lot picker', () => {
  it('lists every lot, published or not, and marks unpublished ones', async () => {
    mockFetch({ 'GET /admin/lots': { body: [NEW_NORTH, TEST_LOT] } })
    renderApp('/admin', ADMIN)
    const select = await picker()
    expect(select.value).toBe('test-lot')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'North Lot (not published)',
      'Test Lot',
    ])
    expect(screen.getByText('Test Lot', { selector: 'strong' })).toBeInTheDocument()
  })

  it('shows "No lots yet" with a link to New Lot when there are no lots', async () => {
    mockFetch({ 'GET /admin/lots': { body: [] } })
    renderApp('/admin', ADMIN)
    expect(await screen.findByText('No lots yet')).toBeInTheDocument()
    expect(within(screen.getByRole('navigation')).getByRole('link', { name: 'New lot' })).toHaveAttribute(
      'href',
      '/admin/lots/new',
    )
    expect(screen.queryByRole('combobox', { name: 'Lot picker' })).not.toBeInTheDocument()
  })

  it('is only shown to a signed-in admin, and drivers never call the admin API', async () => {
    const fetchMock = mockFetch({ 'GET /lots': { body: [] } })
    renderApp('/')
    await screen.findByText(/no lots/i)
    expect(screen.queryByRole('combobox', { name: 'Lot picker' })).not.toBeInTheDocument()
    expect(calls(fetchMock, 'GET', '/admin/lots')).toHaveLength(0)
  })

  it('falls back to the first published lot when the remembered lot is gone', async () => {
    localStorage.setItem(KEY, 'deleted-lot')
    mockFetch({ 'GET /admin/lots': { body: [NEW_NORTH, TEST_LOT] } })
    renderApp('/admin', ADMIN)
    expect((await picker()).value).toBe('test-lot')
  })

  it('remembers the lot under the key the admin pages share, defined in adminLot (no import cycle)', () => {
    expect(ADMIN_LOT_KEY).toBe(KEY)
  })

  it('resolveLotId keeps a known lot, else the first published, else the first lot', () => {
    const unpublished = adminLot('a', 'A', false)
    expect(resolveLotId('test-lot', null)).toBe('test-lot')
    expect(resolveLotId('test-lot', [unpublished, TEST_LOT])).toBe('test-lot')
    expect(resolveLotId('gone', [unpublished, TEST_LOT])).toBe('test-lot')
    expect(resolveLotId('gone', [unpublished])).toBe('a')
    expect(resolveLotId('gone', [])).toBe('')
  })
})

describe('US-16 #3: lot picker on every admin page', () => {
  const routes = {
    'GET /admin/lots': { body: [NORTH_LOT, TEST_LOT] },
    'GET /lots': { body: [listItem('north-lot', 'North Lot'), listItem('test-lot', 'Test Lot')] },
    'GET /lots/test-lot': { body: lotDetail('test-lot', 'Test Lot', 'Test pole') },
    'GET /lots/north-lot': { body: lotDetail('north-lot', 'North Lot', 'North pole') },
  }

  it('switching lots changes what Upload shows', async () => {
    mockFetch(routes)
    renderApp('/admin/upload', ADMIN)
    expect(await screen.findByRole('option', { name: 'Test pole' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.selectOptions(await picker(), 'north-lot')
    expect(await screen.findByRole('option', { name: 'North pole' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Test pole' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Lot')).toHaveValue('north-lot')
    expect(localStorage.getItem(KEY)).toBe('north-lot')
  })

  it("the Upload page's own lot select moves the picker too", async () => {
    mockFetch(routes)
    renderApp('/admin/upload', ADMIN)
    await screen.findByRole('option', { name: 'Test pole' })
    await userEvent.setup().selectOptions(screen.getByLabelText('Lot'), 'north-lot')
    await waitFor(async () => expect((await picker()).value).toBe('north-lot'))
  })

  it('switching lots changes what Snapshots shows', async () => {
    const fetchMock = mockFetch({
      ...routes,
      'GET /admin/snapshots?lotId=test-lot': { body: [snapshot('img-test', 'test-lot')] },
      'GET /admin/snapshots?lotId=north-lot': { body: [snapshot('img-north', 'north-lot')] },
    })
    renderApp('/admin/snapshots', ADMIN)
    expect(await screen.findByTestId('snapshot-img-test')).toBeInTheDocument()
    await userEvent.setup().selectOptions(await picker(), 'north-lot')
    expect(await screen.findByTestId('snapshot-img-north')).toBeInTheDocument()
    expect(screen.queryByTestId('snapshot-img-test')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('North Lot')
    expect(calls(fetchMock, 'GET', '/admin/snapshots?lotId=north-lot')).toHaveLength(1)
  })

  const status = (lotId: string): LotStatusOut => ({
    lotId, layoutVersion: 1, isStale: false, processing: false, noObservations: true, lastObservedAt: null,
    counts: { free: 0, occupied: 0, unknown: 0, closed: 0 }, spaces: [],
  })
  const closuresRoutes = {
    'GET /lots/test-lot/status': { body: status('test-lot') },
    'GET /lots/north-lot/status': { body: status('north-lot') },
    'GET /admin/lots/test-lot/closures': { body: [] },
    'GET /admin/lots/north-lot/closures': { body: [] },
  }

  it('switching lots reloads the Closures page for the new lot', async () => {
    const fetchMock = mockFetch({ ...routes, ...closuresRoutes })
    renderApp('/admin/closures', ADMIN)
    await waitFor(() => expect(calls(fetchMock, 'GET', '/admin/lots/test-lot/closures')).toHaveLength(1))
    await userEvent.setup().selectOptions(await picker(), 'north-lot')
    await waitFor(() => expect(calls(fetchMock, 'GET', '/admin/lots/north-lot/closures')).toHaveLength(1))
  })

  it('a remembered lot that no longer exists: Closures uses the picked lot, then follows a switch', async () => {
    localStorage.setItem(KEY, 'deleted-lot')
    const fetchMock = mockFetch({ ...routes, ...closuresRoutes })
    renderApp('/admin/closures', ADMIN)
    expect(await screen.findByRole('heading', { name: 'Closures: North Lot' })).toBeInTheDocument()
    expect((await picker()).value).toBe('north-lot')
    await userEvent.setup().selectOptions(await picker(), 'test-lot')
    expect(await screen.findByRole('heading', { name: 'Closures: Test Lot' })).toBeInTheDocument()
    expect(calls(fetchMock, 'GET', '/admin/lots/test-lot/closures')).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('deleted-lot'))).toBe(false)
  })

  it('B1: picking an unpublished lot and opening Closures says to publish it first', async () => {
    const fetchMock = mockFetch({ ...routes, 'GET /admin/lots': { body: [NEW_NORTH, TEST_LOT] }, ...closuresRoutes })
    renderApp('/admin', ADMIN)
    const user = userEvent.setup()
    await user.selectOptions(await picker(), 'north-lot')
    await user.click(screen.getByRole('link', { name: 'Closures' }))
    expect(await screen.findByText(/Publish the lot before closing spaces/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Closures: North Lot' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(fetchMock, 'GET', '/lots/north-lot')).toHaveLength(0)
  })

  it('switching lots on the mapping page opens the same page for the new lot', async () => {
    mockFetch({
      ...routes,
      'GET /admin/lots/test-lot/layout/draft': { body: draftFixture() },
      'GET /admin/lots/north-lot/layout/draft': { body: draftFixture({ lotId: 'north-lot' }) },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await userEvent.setup().selectOptions(await picker(), 'north-lot')
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/lots/north-lot/map')
  })

  it('a lot in the URL becomes the picked lot', async () => {
    mockFetch({ ...routes, 'GET /admin/lots/north-lot/layout/draft': { body: draftFixture({ lotId: 'north-lot' }) } })
    renderApp('/admin/lots/north-lot/map', ADMIN)
    await waitFor(async () => expect((await picker()).value).toBe('north-lot'))
    expect(localStorage.getItem(KEY)).toBe('north-lot')
  })
})

describe('Admin home Map link', () => {
  const mapLink = () => screen.findByRole('link', { name: 'Map' })

  it('points at the picked lot, published or not', async () => {
    localStorage.setItem(KEY, 'north-lot')
    mockFetch({ 'GET /admin/lots': { body: [NEW_NORTH, TEST_LOT] } })
    renderApp('/admin', ADMIN)
    await waitFor(async () => expect(await mapLink()).toHaveAttribute('href', '/admin/lots/north-lot/map'))
  })

  it("follows the picker's fallback when the remembered lot is gone", async () => {
    localStorage.setItem(KEY, 'deleted-lot')
    mockFetch({ 'GET /admin/lots': { body: [NEW_NORTH, TEST_LOT] } })
    renderApp('/admin', ADMIN)
    expect((await picker()).value).toBe('test-lot')
    expect(await mapLink()).toHaveAttribute('href', '/admin/lots/test-lot/map')
  })

  it('is disabled when there are no lots', async () => {
    localStorage.clear()
    mockFetch({ 'GET /admin/lots': { body: [] } })
    renderApp('/admin', ADMIN)
    expect(await screen.findByText('(no lots yet)')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Map' })).not.toBeInTheDocument()
  })
})

describe('New Lot page', () => {
  const emptyDraft = draftFixture({ lotId: 'north-lot', basedOnVersion: null, spaces: [], viewpoints: [] })

  it('US-16 #1: creating a lot adds it to the picker with an empty draft', async () => {
    let created = false
    const fetchMock = mockFetch({
      'GET /admin/lots': () => ({ body: created ? [NEW_NORTH, TEST_LOT] : [TEST_LOT] }),
      'POST /admin/lots': () => {
        created = true
        return { status: 201, body: NEW_NORTH }
      },
      'GET /lots/north-lot': { status: 404, body: { error: 'not_found', message: 'Lot not found' } },
      'GET /admin/lots/north-lot/layout/draft': { body: emptyDraft },
    })
    renderApp('/admin/lots/new', ADMIN)
    expect(within(await picker()).getAllByRole('option')).toHaveLength(1)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Name'), '  North Lot ')
    await user.type(screen.getByLabelText('Location'), 'North campus')
    await user.clear(screen.getByLabelText('Allowed data age (minutes)'))
    await user.type(screen.getByLabelText('Allowed data age (minutes)'), '45')
    await user.click(screen.getByRole('button', { name: 'Create lot' }))

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/admin/lots/north-lot/map'))
    const [, init] = calls(fetchMock, 'POST', '/admin/lots')[0]
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'North Lot', location: 'North campus', staleAfterMinutes: 45 })
    const select = await picker()
    expect(select.value).toBe('north-lot')
    expect(within(select).getByRole('option', { name: 'North Lot (not published)' })).toBeInTheDocument()
    expect(localStorage.getItem(KEY)).toBe('north-lot')
    await waitFor(() => expect(calls(fetchMock, 'GET', '/admin/lots/north-lot/layout/draft')).toHaveLength(1))
    expect(await screen.findByText(/Not published yet/)).toBeInTheDocument()
  })

  it('US-16 #2: a duplicate name shows the message and nothing is created', async () => {
    const fetchMock = mockFetch({
      'GET /admin/lots': { body: [TEST_LOT] },
      'POST /admin/lots': {
        status: 409,
        body: { error: 'duplicate_lot_name', message: 'A lot with this name already exists' },
      },
    })
    renderApp('/admin/lots/new', ADMIN)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Name'), 'Test Lot')
    await user.click(screen.getByRole('button', { name: 'Create lot' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A lot with this name already exists')
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/lots/new')
    expect(within(await picker()).getAllByRole('option')).toHaveLength(1)
    expect(localStorage.getItem(KEY)).toBe('test-lot')
    expect(calls(fetchMock, 'POST', '/admin/lots')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Create lot' })).toBeEnabled()
  })

  it('checks the name and data age before calling the API', async () => {
    const fetchMock = mockFetch({ 'GET /admin/lots': { body: [TEST_LOT] } })
    renderApp('/admin/lots/new', ADMIN)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Name'), '   ')
    await user.click(screen.getByRole('button', { name: 'Create lot' }))
    expect(screen.getByRole('alert')).toHaveTextContent(NAME_REQUIRED)

    await user.type(screen.getByLabelText('Name'), 'North Lot')
    const age = screen.getByLabelText('Allowed data age (minutes)')
    for (const bad of ['0', '1441', '2.5']) {
      await user.clear(age)
      await user.type(age, bad)
      await user.click(screen.getByRole('button', { name: 'Create lot' }))
      expect(screen.getByRole('alert')).toHaveTextContent(AGE_RANGE)
    }
    expect(calls(fetchMock, 'POST', '/admin/lots')).toHaveLength(0)
  })

  it('is behind the admin guard', () => {
    mockFetch({})
    renderApp('/admin/lots/new')
    expect(screen.getByTestId('location')).toHaveTextContent('/signin?next=%2Fadmin%2Flots%2Fnew')
  })
})
