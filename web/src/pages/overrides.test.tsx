import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminLotOut } from '../api/lotsAdmin'
import type { OverrideOut } from '../api/overrides'
import type { LotDetail, LotStatusOut, SpaceStatusOut } from '../api/schemas'
import { overrideWindow, setByAdminText, timeOrDateTime } from '../lib/overrides'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'

const LABELS = ['A-01', 'A-02', 'A-03', 'B-01', 'B-02', 'B-03']
const URL = '/admin/lots/test-lot/overrides'

const detail: LotDetail = {
  lot: { lotId: 'test-lot', name: 'Test Lot', location: 'x', staleAfterMinutes: 30 },
  viewpoints: [{ viewId: 'V1', name: 'East pole' }],
  layout: {
    version: 1,
    schematic: { width: 1000, height: 600 },
    spaces: LABELS.map((label, i) => ({
      spaceId: label,
      label,
      type: 'STANDARD' as const,
      rect: { x: (i % 3) * 120, y: label.startsWith('A') ? 0 : 300, w: 110, h: 180 },
    })),
  },
}

const adminLot = (lotId: string, name: string, published = true): AdminLotOut => ({
  lotId, name, location: 'x', staleAfterMinutes: 30, published, layoutVersion: published ? 1 : null,
  createdAt: '2026-10-01T12:00:00Z',
})
const TEST_LOT = adminLot('test-lot', 'Test Lot')
const NORTH_LOT = adminLot('north-lot', 'North Lot', false)

const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString()
/** Today at the given local time, so "until" renders as a time only. */
const today = (h: number, mi = 0) => {
  const d = new Date()
  d.setHours(h, mi, 0, 0)
  return d.toISOString()
}

const row = (spaceId: string, over: Partial<SpaceStatusOut> = {}): SpaceStatusOut => ({
  spaceId, state: 'FREE', stale: false, observedAt: '2026-10-21T10:00:00Z', score: 0.1, closure: null,
  source: 'camera', views: ['V1'], override: null, ...over,
})

const status: LotStatusOut = {
  lotId: 'test-lot',
  layoutVersion: 1,
  isStale: false,
  processing: false,
  noObservations: false,
  lastObservedAt: '2026-10-21T10:00:00Z',
  counts: { free: 5, occupied: 1, unknown: 0, closed: 0 },
  spaces: LABELS.map((id) =>
    id === 'B-02'
      ? row(id, { state: 'OCCUPIED', source: 'admin', views: [], override: { state: 'OCCUPIED', endsAt: null, note: '' } })
      : row(id),
  ),
}

const active: OverrideOut = {
  overrideId: 'ov_1',
  lotId: 'test-lot',
  spaceIds: ['B-01', 'B-02', 'B-03'],
  state: 'OCCUPIED',
  note: 'Coned for the game',
  startsAt: local(2026, 10, 31, 9),
  endsAt: local(2026, 10, 31, 15),
  createdBy: 'admin@example.edu',
  createdAt: local(2026, 10, 31, 8, 55),
  endedAt: null,
  active: true,
  status: 'ACTIVE',
}
const ended: OverrideOut = {
  ...active,
  overrideId: 'ov_0',
  spaceIds: ['A-02'],
  state: 'FREE',
  note: '',
  startsAt: local(2026, 10, 1, 8),
  endsAt: null,
  endedAt: local(2026, 10, 2, 15, 12),
  active: false,
  status: 'ENDED',
}

beforeEach(() => {
  localStorage.setItem('parking.admin.lotId', 'test-lot')
})
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

/** A GET handler that replies with each list in turn, then keeps the last. */
function sequence(...lists: OverrideOut[][]) {
  let n = 0
  return () => ({ body: lists[Math.min(n++, lists.length - 1)] })
}

async function setup(routes: Parameters<typeof mockFetch>[0] = {}) {
  const fetchMock = mockFetch({
    'GET /admin/lots': { body: [TEST_LOT] },
    'GET /lots/test-lot': { body: detail },
    'GET /lots/test-lot/status': { body: status },
    [`GET ${URL}`]: { body: [active, ended] },
    ...routes,
  })
  renderApp('/admin/overrides', ADMIN)
  await screen.findByRole('button', { name: 'Row B' })
  return { fetchMock, user: userEvent.setup() }
}

const calls = (fetchMock: ReturnType<typeof mockFetch>, method: string, path: string) =>
  fetchMock.mock.calls.filter(([u, init]) => (init?.method ?? 'GET') === method && String(u) === `/api${path}`)

/** Pick A-01 and A-03 on the map and open the dialog. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('space-A-01'))
  await user.click(screen.getByTestId('space-A-03'))
  expect(screen.getByText('2 selected')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Set state…' }))
  return screen.getByRole('dialog', { name: 'Set state' })
}

describe('overrides list', () => {
  it('shows each override with spaces, state, window, note, creator and status', async () => {
    await setup()
    expect(screen.getByRole('heading', { name: 'Set space state: Test Lot' })).toBeInTheDocument()
    const r = within(await screen.findByTestId('override-ov_1'))
    expect(r.getByText('B-01 to B-03')).toBeInTheDocument()
    expect(r.getByText('Occupied')).toBeInTheDocument()
    expect(r.getByText('Oct 31, 9:00 AM to 3:00 PM')).toBeInTheDocument()
    expect(r.getByText('Coned for the game')).toBeInTheDocument()
    expect(r.getByText('admin@example.edu')).toBeInTheDocument()
    expect(r.getByText('Active')).toBeInTheDocument()
    expect(r.getByRole('button', { name: 'End override for B-01 to B-03' })).toHaveTextContent('End')

    const old = within(screen.getByTestId('override-ov_0'))
    expect(old.getByText('A-02')).toBeInTheDocument()
    expect(old.getByText('Free')).toBeInTheDocument()
    expect(old.getByText('from Oct 1, 8:00 AM, until ended; ended Oct 2, 3:12 PM')).toBeInTheDocument()
    expect(old.getByText('Ended')).toBeInTheDocument()
    expect(old.queryByRole('button', { name: /End override/ })).toBeNull()
  })

  it('says when there are no overrides', async () => {
    await setup({ [`GET ${URL}`]: { body: [] } })
    expect(await screen.findByText('No overrides yet.')).toBeInTheDocument()
  })

  it('marks spaces an admin set with the ADMIN tag on the map', async () => {
    await setup()
    expect(screen.getByTestId('admin-badge-B-02')).toHaveTextContent('ADMIN')
    expect(screen.queryByTestId('admin-badge-B-01')).toBeNull()
    expect(screen.getByTestId('space-B-02')).toHaveAttribute('aria-label', 'B-02: Occupied, set by admin')
    expect(within(screen.getByRole('region', { name: 'Legend' })).getByText('Set by admin')).toBeInTheDocument()
  })

  it('"End" sends DELETE and the row shows it ended', async () => {
    const endedNow: OverrideOut = { ...active, endedAt: new Date().toISOString(), active: false, status: 'ENDED' }
    const { fetchMock, user } = await setup({
      [`GET ${URL}`]: sequence([active, ended], [endedNow, ended]),
      [`DELETE ${URL}/ov_1`]: { body: endedNow },
    })
    const r = within(await screen.findByTestId('override-ov_1'))
    await user.click(r.getByRole('button', { name: 'End override for B-01 to B-03' }))
    await waitFor(() => expect(calls(fetchMock, 'DELETE', `${URL}/ov_1`)).toHaveLength(1))
    expect(await r.findByText('Ended')).toBeInTheDocument()
    expect(r.queryByRole('button', { name: /End override/ })).toBeNull()
    expect(calls(fetchMock, 'GET', '/lots/test-lot/status')).toHaveLength(2)
  })

  it('shows 409 already_ended inline and reloads the list', async () => {
    const { fetchMock, user } = await setup({
      [`DELETE ${URL}/ov_1`]: { status: 409, body: { error: 'already_ended', message: 'This override has already ended' } },
    })
    const r = within(await screen.findByTestId('override-ov_1'))
    await user.click(r.getByRole('button', { name: /End override/ }))
    const list = within(screen.getByRole('region', { name: 'Overrides' }))
    expect(await list.findByText('This override has already ended')).toBeInTheDocument()
    await waitFor(() => expect(calls(fetchMock, 'GET', URL)).toHaveLength(2))
  })

  it('an unpublished lot says to publish it first instead of failing to load', async () => {
    localStorage.setItem('parking.admin.lotId', 'north-lot')
    const fetchMock = mockFetch({ 'GET /admin/lots': { body: [NORTH_LOT, TEST_LOT] } })
    renderApp('/admin/overrides', ADMIN)
    expect(await screen.findByText(/Publish the lot before setting space states/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Set space state: North Lot' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the map editor' })).toHaveAttribute('href', '/admin/lots/north-lot/map')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set state…' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('north-lot'))).toBe(false)
  })
})

describe('setting space state', () => {
  it('posts the spaces picked on the map, state, note and startsAt now, then lists it', async () => {
    let posted: Record<string, unknown> = {}
    const created: OverrideOut = {
      ...active, overrideId: 'ov_2', spaceIds: ['A-01', 'A-03'], note: 'VIP visit', endsAt: null, startsAt: today(0),
    }
    const { fetchMock, user } = await setup({
      [`GET ${URL}`]: sequence([active, ended], [created, active, ended]),
      [`POST ${URL}`]: (init) => {
        posted = JSON.parse(String(init?.body))
        return { status: 201, body: created }
      },
    })
    const dialog = within(await openDialog(user))
    expect(dialog.getByText('Spaces: A-01, A-03 (2 selected)')).toBeInTheDocument()
    await user.click(dialog.getByRole('radio', { name: 'Occupied' }))
    await user.type(dialog.getByLabelText(/^Note/), '  VIP visit ')
    const before = Date.now()
    await user.click(dialog.getByRole('button', { name: 'Set state' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls(fetchMock, 'POST', URL)).toHaveLength(1)
    expect(posted).toEqual({
      spaceIds: ['A-01', 'A-03'], state: 'OCCUPIED', note: 'VIP visit', startsAt: expect.any(String), endsAt: null,
    })
    const startsAt = new Date(String(posted.startsAt))
    expect(startsAt.toISOString()).toBe(posted.startsAt)
    expect(Math.abs(startsAt.getTime() - before)).toBeLessThan(5_000)
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    expect(within(await screen.findByTestId('override-ov_2')).getByText('VIP visit')).toBeInTheDocument()
    expect(calls(fetchMock, 'GET', '/lots/test-lot/status')).toHaveLength(2)
  })

  it('sends an optional "until" time as endsAt', async () => {
    let posted: Record<string, unknown> = {}
    const { user } = await setup({
      [`POST ${URL}`]: (init) => {
        posted = JSON.parse(String(init?.body))
        return { status: 201, body: { ...active, overrideId: 'ov_3' } }
      },
    })
    const dialog = within(await openDialog(user))
    await user.click(dialog.getByRole('radio', { name: 'Free' }))
    await user.type(dialog.getByLabelText(/^Until/), '2099-11-07T15:00')
    await user.click(dialog.getByRole('button', { name: 'Set state' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(posted).toMatchObject({ state: 'FREE', note: '', endsAt: local(2099, 11, 7, 15) })
  })

  it('asks for a state and a future "until" time without calling the API', async () => {
    const { fetchMock, user } = await setup()
    const dialog = within(await openDialog(user))
    await user.click(dialog.getByRole('button', { name: 'Set state' }))
    expect(await dialog.findByText('Choose Free or Occupied')).toBeInTheDocument()
    await user.click(dialog.getByRole('radio', { name: 'Free' }))
    await user.type(dialog.getByLabelText(/^Until/), '2020-01-01T09:00')
    await user.click(dialog.getByRole('button', { name: 'Set state' }))
    expect(await dialog.findByText('Choose an "until" time in the future')).toBeInTheDocument()
    expect(calls(fetchMock, 'POST', URL)).toHaveLength(0)
  })

  it.each([
    [422, 'unknown_space', 'Unknown or retired space: A-03'],
    [422, 'invalid_window', 'End time must be after start time'],
    [409, 'not_published', 'Publish the lot before setting space states'],
  ])('shows a %i %s error inside the dialog', async (code, error, message) => {
    const { user } = await setup({ [`POST ${URL}`]: { status: code, body: { error, message } } })
    const dialog = within(await openDialog(user))
    await user.click(dialog.getByRole('radio', { name: 'Occupied' }))
    await user.type(dialog.getByLabelText(/^Until/), '2099-11-07T15:00')
    await user.click(dialog.getByRole('button', { name: 'Set state' }))
    expect(await dialog.findByText(message)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('returns focus to "Set state…" when the dialog is cancelled', async () => {
    const { user } = await setup()
    const dialog = within(await openDialog(user))
    expect(dialog.getByRole('radio', { name: 'Free' })).toHaveFocus()
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Set state…' })).toHaveFocus()
  })
})

describe('admin guard and home link', () => {
  it('sends a signed-out visitor to sign in', async () => {
    mockFetch({})
    renderApp('/admin/overrides')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/signin?next=%2Fadmin%2Foverrides'))
  })

  it('refuses a signed-in non-admin', async () => {
    mockFetch({})
    renderApp('/admin/overrides', { ...ADMIN, groups: [] })
    expect(await screen.findByText('You do not have admin access')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Set space state/ })).toBeNull()
  })

  it('admin home links to the page', async () => {
    mockFetch({})
    renderApp('/admin', ADMIN)
    expect(await screen.findByRole('link', { name: 'Set space state' })).toHaveAttribute('href', '/admin/overrides')
  })
})

describe('driver map', () => {
  const driverDetail: LotDetail = {
    ...detail,
    lot: { ...detail.lot, lotId: 'lot-a', name: 'Lot A' },
  }
  const driverStatus = (spaces: SpaceStatusOut[]): LotStatusOut => ({ ...status, lotId: 'lot-a', spaces })

  function renderDriver(spaces: SpaceStatusOut[]) {
    mockFetch({ 'GET /lots/lot-a': { body: driverDetail }, 'GET /lots/lot-a/status': { body: driverStatus(spaces) } })
    renderApp('/lots/lot-a')
  }

  it('tags a space an admin set and says until when', async () => {
    renderDriver([
      row('A-01', { state: 'OCCUPIED', source: 'admin', override: { state: 'OCCUPIED', endsAt: today(15), note: 'Event' } }),
      row('A-02', { state: 'FREE', source: 'admin', override: { state: 'FREE', endsAt: null, note: '' } }),
      row('A-03'),
    ])
    const a1 = await screen.findByTestId('space-A-01')
    expect(screen.getByTestId('admin-badge-A-01')).toHaveTextContent('ADMIN')
    expect(screen.getByTestId('admin-badge-A-02')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-badge-A-03')).toBeNull()
    expect(a1).toHaveAttribute('aria-label', 'A-01: Occupied. Set by admin until 3:00 PM. Note: Event')
    expect(screen.getByTestId('space-A-02')).toHaveAttribute('aria-label', 'A-02: Free. Set by admin')
    expect(screen.getByTestId('space-A-03').getAttribute('aria-label')).toMatch(/^A-03: Free, observed /)

    await userEvent.setup().click(a1)
    expect(screen.getByTestId('space-popover')).toHaveTextContent('Set by admin until 3:00 PM. Note: Event')
    expect(within(screen.getByRole('region', { name: 'Legend' })).getByText('Set by admin')).toBeInTheDocument()
  })

  it('a closed space still shows as closed, without the tag', async () => {
    renderDriver([
      row('A-01', { state: 'CLOSED', source: 'closure', override: null, closure: { reason: 'EVENT', endsAt: null } }),
      row('A-02'),
    ])
    const a1 = await screen.findByTestId('space-A-01')
    expect(a1).toHaveAttribute('data-state', 'CLOSED')
    expect(a1).toHaveClass('space--closed')
    expect(a1.querySelector('[data-icon="barrier"]')).not.toBeNull()
    expect(screen.queryByTestId('admin-badge-A-01')).toBeNull()
    expect(a1.getAttribute('aria-label')).toMatch(/closed for event$/)
  })
})

describe('override helpers', () => {
  it('formats the driver note and the admin window', () => {
    const ref = new Date(2099, 10, 7, 9)
    expect(setByAdminText({ state: 'FREE', endsAt: local(2099, 11, 7, 15), note: '' }, ref)).toBe('Set by admin until 3:00 PM')
    expect(setByAdminText({ state: 'FREE', endsAt: local(2099, 11, 8, 15), note: '' }, ref)).toBe('Set by admin until Nov 8, 3:00 PM')
    expect(setByAdminText(null, ref)).toBe('Set by admin')
    expect(timeOrDateTime(local(2099, 11, 7, 6), ref)).toBe('6:00 AM')
    expect(overrideWindow({ startsAt: local(2099, 11, 7, 6), endsAt: local(2099, 11, 8, 6), endedAt: null })).toBe(
      'Nov 7, 6:00 AM to Nov 8, 6:00 AM',
    )
  })
})
