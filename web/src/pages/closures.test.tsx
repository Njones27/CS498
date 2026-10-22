import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClosureOut } from '../api/closures'
import type { LotDetail, LotListItem, LotStatusOut } from '../api/schemas'
import { closureWindow, compactLabels } from '../lib/closures'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'

const LABELS = [...['A-01', 'A-02', 'A-03'], ...Array.from({ length: 7 }, (_, i) => `B-0${i + 1}`)]
const ROW_B = LABELS.filter((l) => l.startsWith('B-'))
const URL = '/admin/lots/test-lot/closures'

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
      rect: { x: (i % 7) * 120, y: label.startsWith('A') ? 0 : 300, w: 110, h: 180 },
    })),
  },
}

const status: LotStatusOut = {
  lotId: 'test-lot',
  layoutVersion: 1,
  isStale: false,
  processing: false,
  noObservations: false,
  lastObservedAt: '2026-10-21T10:00:00Z',
  counts: { free: 10, occupied: 0, unknown: 0, closed: 0 },
  spaces: LABELS.map((spaceId) => ({
    spaceId, state: 'FREE' as const, stale: false, observedAt: '2026-10-21T10:00:00Z', score: 0.1, closure: null,
  })),
}

const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString()

const scheduled: ClosureOut = {
  closureId: 'cl_1',
  lotId: 'test-lot',
  spaceIds: ROW_B,
  reason: 'EVENT',
  startsAt: local(2099, 11, 7, 6),
  endsAt: local(2099, 11, 7, 22),
  createdBy: 'admin@example.edu',
  createdAt: local(2026, 10, 20, 9, 30),
  endedAt: null,
  active: false,
  status: 'SCHEDULED',
}
const ended: ClosureOut = {
  ...scheduled,
  closureId: 'cl_0',
  spaceIds: ['A-02'],
  reason: 'MAINTENANCE',
  startsAt: local(2026, 10, 1, 8),
  endsAt: null,
  endedAt: local(2026, 10, 2, 15, 12),
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

async function setup(routes: Parameters<typeof mockFetch>[0] = {}, closures: ClosureOut[] = [scheduled, ended]) {
  const fetchMock = mockFetch({
    'GET /lots/test-lot': { body: detail },
    'GET /lots/test-lot/status': { body: status },
    [`GET ${URL}`]: { body: closures },
    ...routes,
  })
  renderApp('/admin/closures', ADMIN)
  await screen.findByRole('button', { name: 'Row B' })
  return { fetchMock, user: userEvent.setup() }
}

const calls = (fetchMock: ReturnType<typeof mockFetch>, method: string, path: string) =>
  fetchMock.mock.calls.filter(([u, init]) => (init?.method ?? 'GET') === method && String(u) === `/api${path}`)

async function openDialogForRowB(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Row B' }))
  expect(screen.getByText('7 selected')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Close spaces…' }))
  return screen.getByRole('dialog', { name: 'Close spaces' })
}

describe('closures list', () => {
  it('shows each closure with spaces, reason, window, creator and status', async () => {
    await setup()
    const row = within(await screen.findByTestId('closure-cl_1'))
    expect(row.getByText('B-01 to B-07')).toBeInTheDocument()
    expect(row.getByText('Event')).toBeInTheDocument()
    expect(row.getByText('Nov 7, 6:00 AM to 10:00 PM')).toBeInTheDocument()
    expect(row.getByText('admin@example.edu')).toBeInTheDocument()
    expect(row.getByText('Scheduled')).toBeInTheDocument()
    expect(row.getByRole('button', { name: 'End closure for B-01 to B-07' })).toHaveTextContent('End now')

    const old = within(screen.getByTestId('closure-cl_0'))
    expect(old.getByText('A-02')).toBeInTheDocument()
    expect(old.getByText('Maintenance')).toBeInTheDocument()
    expect(old.getByText('from Oct 1, 8:00 AM, open-ended; ended Oct 2, 3:12 PM')).toBeInTheDocument()
    expect(old.getByText('Ended')).toBeInTheDocument()
    expect(old.queryByRole('button', { name: /End closure/ })).toBeNull()
  })

  it('trusts the server status, not the browser clock', async () => {
    const started: ClosureOut = {
      ...scheduled, closureId: 'cl_3', startsAt: local(2020, 1, 1, 8), endsAt: null, active: false, status: 'ACTIVE',
    }
    await setup({}, [started])
    const row = within(await screen.findByTestId('closure-cl_3'))
    expect(row.getByText('Active')).toBeInTheDocument()
    expect(row.getByRole('button', { name: 'End closure for B-01 to B-07' })).toBeEnabled()
  })

  it('"End now" sends DELETE for that closure and reloads', async () => {
    const { fetchMock, user } = await setup({
      [`DELETE ${URL}/cl_1`]: { body: { ...scheduled, endedAt: new Date().toISOString() } },
    })
    const row = within(await screen.findByTestId('closure-cl_1'))
    await user.click(row.getByRole('button', { name: /End closure/ }))
    await waitFor(() => expect(calls(fetchMock, 'DELETE', `${URL}/cl_1`)).toHaveLength(1))
    await waitFor(() => expect(calls(fetchMock, 'GET', URL)).toHaveLength(2))
  })

  it('reloads the list even when ending fails (409 already_ended)', async () => {
    const { fetchMock, user } = await setup({
      [`DELETE ${URL}/cl_1`]: { status: 409, body: { error: 'already_ended', message: 'This closure has already ended' } },
    })
    const row = within(await screen.findByTestId('closure-cl_1'))
    await user.click(row.getByRole('button', { name: /End closure/ }))
    expect(await screen.findByText('This closure has already ended')).toBeInTheDocument()
    await waitFor(() => expect(calls(fetchMock, 'GET', URL)).toHaveLength(2))
  })

  it('falls back to the first published lot when none is remembered', async () => {
    localStorage.clear()
    const lots: LotListItem[] = [
      {
        lotId: 'test-lot', name: 'Test Lot', location: 'x', staleAfterMinutes: 30, layoutVersion: 1,
        summary: { free: 0, occupied: 0, unknown: 0, closed: 0, total: 0, openPercent: null, hasRecentData: false, isStale: false },
      },
    ]
    await setup({ 'GET /lots': { body: lots } })
    expect(await screen.findByRole('heading', { name: 'Closures: Test Lot' })).toBeInTheDocument()
  })

  it('says "No lots yet" when there are no lots', async () => {
    localStorage.clear()
    mockFetch({ 'GET /lots': { body: [] } })
    renderApp('/admin/closures', ADMIN)
    expect(await screen.findByText('No lots yet')).toBeInTheDocument()
  })
})

describe('closing spaces', () => {
  it('selects a row and posts the closure', async () => {
    let posted: Record<string, unknown> = {}
    const { fetchMock, user } = await setup({
      [`POST ${URL}`]: (init) => {
        posted = JSON.parse(String(init?.body))
        return { status: 201, body: { ...scheduled, closureId: 'cl_2' } }
      },
    })
    const dialog = within(await openDialogForRowB(user))
    expect(dialog.getByText('Spaces: B-01 to B-07 (7 selected)')).toBeInTheDocument()
    await user.selectOptions(dialog.getByLabelText('Reason'), 'Event')
    await user.click(dialog.getByRole('button', { name: 'Close spaces' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const [post] = calls(fetchMock, 'POST', URL)
    expect(post[1]?.method).toBe('POST')
    expect(posted).toEqual({ spaceIds: ROW_B, reason: 'EVENT', startsAt: expect.any(String), endsAt: null })
    expect(new Date(String(posted.startsAt)).toISOString()).toBe(posted.startsAt)
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    await waitFor(() => expect(calls(fetchMock, 'GET', URL)).toHaveLength(2))
    expect(calls(fetchMock, 'GET', '/lots/test-lot/status')).toHaveLength(2)
  })

  it('rejects an end time before the start time without calling the API', async () => {
    const { fetchMock, user } = await setup()
    const dialog = within(await openDialogForRowB(user))
    await user.selectOptions(dialog.getByLabelText('Reason'), 'Event')
    const starts = dialog.getByLabelText('Starts')
    await user.clear(starts)
    await user.type(starts, '2099-11-07T10:00')
    await user.type(dialog.getByLabelText(/^Ends/), '2099-11-07T09:00')
    expect(starts).toHaveValue('2099-11-07T10:00')
    expect(dialog.getByLabelText(/^Ends/)).toHaveValue('2099-11-07T09:00')
    await user.click(dialog.getByRole('button', { name: 'Close spaces' }))
    expect(await dialog.findByText('End time must be after start time')).toBeInTheDocument()
    expect(calls(fetchMock, 'POST', URL)).toHaveLength(0)
  })

  it('shows a server error inside the dialog', async () => {
    const { user } = await setup({
      [`POST ${URL}`]: { status: 409, body: { error: 'not_published', message: 'Publish the lot before closing spaces' } },
    })
    const dialog = within(await openDialogForRowB(user))
    await user.selectOptions(dialog.getByLabelText('Reason'), 'Construction')
    await user.click(dialog.getByRole('button', { name: 'Close spaces' }))
    expect(await dialog.findByText('Publish the lot before closing spaces')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('returns focus to "Close spaces…" when the dialog is cancelled', async () => {
    const { user } = await setup()
    const dialog = within(await openDialogForRowB(user))
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close spaces…' })).toHaveFocus()
  })

  it('toggles single spaces by click and keyboard, and clears the selection', async () => {
    const { user } = await setup()
    const a1 = screen.getByTestId('space-A-01')
    await user.click(a1)
    expect(a1).toHaveClass('space--selected')
    expect(a1).toHaveAttribute('aria-pressed', 'true')
    a1.focus()
    await user.keyboard('{Enter}')
    expect(a1).not.toHaveClass('space--selected')
    await user.keyboard(' ')
    expect(a1).toHaveClass('space--selected')
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close spaces…' })).toBeDisabled()
  })
})

describe('closure helpers', () => {
  it('compacts consecutive labels into ranges', () => {
    expect(compactLabels(ROW_B)).toBe('B-01 to B-07')
    expect(compactLabels(['A-01', 'A-02'])).toBe('A-01, A-02')
    expect(compactLabels(['A-01', 'A-02', 'A-03', 'A-05', 'B-01'])).toBe('A-01 to A-03, A-05, B-01')
    expect(compactLabels(['North'])).toBe('North')
  })

  it('formats a multi-day window', () => {
    expect(closureWindow({ ...scheduled, endsAt: local(2099, 11, 8, 6) })).toBe('Nov 7, 6:00 AM to Nov 8, 6:00 AM')
  })
})

describe('admin home', () => {
  it('links to the closures page', async () => {
    mockFetch({})
    renderApp('/admin', ADMIN)
    expect(await screen.findByRole('link', { name: 'Closures' })).toHaveAttribute('href', '/admin/closures')
  })
})
