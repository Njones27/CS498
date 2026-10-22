import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LotDetail, LotListItem, LotStatusOut } from '../api/schemas'
import { mockFetch, renderApp } from '../test/helpers'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

const detail: LotDetail = {
  lot: { lotId: 'lot-a', name: 'Lot A', location: 'North', staleAfterMinutes: 15 },
  viewpoints: [{ viewId: 'v1', name: 'East pole' }],
  layout: {
    version: 1,
    schematic: { width: 300, height: 100 },
    spaces: ['A-01', 'A-02', 'A-03'].map((label, i) => ({
      spaceId: `s${i + 1}`,
      label,
      type: 'STANDARD' as const,
      rect: { x: i * 100, y: 0, w: 90, h: 100 },
    })),
  },
}

function status(over: Partial<LotStatusOut> = {}): LotStatusOut {
  return {
    lotId: 'lot-a',
    layoutVersion: 1,
    isStale: true,
    processing: false,
    noObservations: false,
    lastObservedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    counts: { free: 1, occupied: 1, unknown: 1, closed: 0 },
    spaces: [
      { spaceId: 's1', state: 'FREE', stale: false, observedAt: '2026-10-21T10:00:00Z', score: 0.1, closure: null },
      { spaceId: 's2', state: 'OCCUPIED', stale: true, observedAt: '2026-10-21T08:00:00Z', score: 0.9, closure: null },
      { spaceId: 's3', state: 'UNKNOWN', stale: false, observedAt: null, score: null, closure: null },
    ],
    ...over,
  }
}

describe('lot map', () => {
  it('draws icons per state and greys only stale spaces', async () => {
    mockFetch({ 'GET /lots/lot-a': { body: detail }, 'GET /lots/lot-a/status': { body: status() } })
    renderApp('/lots/lot-a')

    const s1 = await screen.findByTestId('space-s1')
    const s2 = screen.getByTestId('space-s2')
    const s3 = screen.getByTestId('space-s3')
    expect(s1).toHaveAttribute('data-stale', 'false')
    expect(s2).toHaveAttribute('data-stale', 'true')
    expect(s3).toHaveAttribute('data-stale', 'false')
    expect(s2).toHaveClass('space--stale')
    expect(s1).not.toHaveClass('space--stale')
    expect(s1.querySelector('[data-icon="empty"]')).not.toBeNull()
    expect(s2.querySelector('[data-icon="car"]')).not.toBeNull()
    expect(within(s3 as unknown as HTMLElement).getByText('?')).toBeInTheDocument()
    expect(screen.getByText('Some spaces are out of date. Check each space for its age.')).toBeInTheDocument()
    expect(screen.getByText('Last observed 5 minutes ago')).toBeInTheDocument()
  })

  it('shows "No observations yet" and the processing note', async () => {
    mockFetch({
      'GET /lots/lot-a': { body: detail },
      'GET /lots/lot-a/status': {
        body: status({ noObservations: true, lastObservedAt: null, isStale: false, processing: true }),
      },
    })
    renderApp('/lots/lot-a')
    expect(await screen.findByText('No observations yet')).toBeInTheDocument()
    expect(screen.getByText('Processing new photo')).toBeInTheDocument()
    expect(screen.queryByText(/Some spaces are out of date/)).toBeNull()
  })

  it('refetches the layout when the status reports a newer layoutVersion', async () => {
    const fetchMock = mockFetch({
      'GET /lots/lot-a': { body: detail },
      'GET /lots/lot-a/status': { body: status({ layoutVersion: 2 }) },
    })
    renderApp('/lots/lot-a')
    await screen.findByTestId('space-s1')
    await vi.waitFor(() => {
      const layoutCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/lots/lot-a'))
      expect(layoutCalls.length).toBe(2)
    })
  })
})

describe('lot list', () => {
  const lot = (over: Partial<LotListItem['summary']>, name = 'Lot A'): LotListItem => ({
    lotId: name.toLowerCase().replace(' ', '-'),
    name,
    location: 'x',
    staleAfterMinutes: 15,
    layoutVersion: 1,
    summary: {
      free: 3, occupied: 7, unknown: 0, closed: 0, total: 10, openPercent: 30,
      hasRecentData: true, isStale: false, ...over,
    },
  })

  it('shows label, percent, count, stale note and no-data bar without signing in', async () => {
    mockFetch({
      'GET /lots': {
        body: [lot({ isStale: true }), lot({ hasRecentData: false, openPercent: null, free: 0 }, 'Lot B')],
      },
    })
    renderApp('/')
    const rows = await screen.findAllByTestId('lot-row')
    expect(within(rows[0]).getByText('Plenty')).toBeInTheDocument()
    expect(within(rows[0]).getByText('30% open')).toBeInTheDocument()
    expect(within(rows[0]).getByText('3/10 open')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Some data out of date')).toBeInTheDocument()
    expect(within(rows[1]).getByText('no recent data')).toBeInTheDocument()
    expect(within(rows[1]).queryByText(/% open/)).toBeNull()
    expect(rows[0]).toHaveAttribute('href', '/lots/lot-a')
    expect(screen.queryByText(/sign in/i)).toBeNull()
  })
})
