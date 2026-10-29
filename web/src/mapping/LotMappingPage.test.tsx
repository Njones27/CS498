import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LotDetail, LotListItem } from '../api/schemas'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'
import { draftFixture } from './fixtures/kevin'
import { toDraftUpdate } from './useDraftLayout'

const URL = '/admin/lots/test-lot/layout/draft'
const STALE = 'This draft changed in another window. Reload to see the latest.'

const detail: LotDetail = {
  lot: { lotId: 'test-lot', name: 'Test Lot', location: 'x', staleAfterMinutes: 30 },
  viewpoints: [{ viewId: 'V1', name: 'North corner' }],
  layout: { version: 1, schematic: { width: 1000, height: 600 }, spaces: [] },
}

const lotItem = (lotId: string): LotListItem => ({
  lotId,
  name: lotId,
  location: '',
  staleAfterMinutes: 30,
  layoutVersion: 1,
  summary: { free: 0, occupied: 0, unknown: 0, closed: 0, total: 0, openPercent: null, hasRecentData: false, isStale: false },
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

const heading = () => screen.getByRole('heading', { level: 1 })

describe('LotMappingPage', () => {
  it('shows the lot and the version the draft is based on', async () => {
    mockFetch({ 'GET /lots/test-lot': { body: detail }, [`GET ${URL}`]: { body: draftFixture() } })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await waitFor(() => expect(heading()).toHaveTextContent('Lot Mapping · Test Lot · Draft based on v1'))
    expect(screen.getByRole('region', { name: 'Schematic' })).toHaveTextContent('2 spaces, 1 retired')
    expect(screen.getByRole('region', { name: 'Reference photo' })).toHaveTextContent('V1 North corner, V2 South corner')
    expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
  })

  it('says "Not published yet" for an unpublished lot', async () => {
    mockFetch({
      'GET /lots/draft': { status: 404, body: { error: 'not_found', message: 'Lot not found' } },
      'GET /admin/lots/draft/layout/draft': {
        body: draftFixture({ lotId: 'draft', basedOnVersion: null, spaces: [], viewpoints: [] }),
      },
    })
    renderApp('/admin/lots/draft/map', ADMIN)
    await waitFor(() => expect(heading()).toHaveTextContent('Lot Mapping · draft · Not published yet'))
    expect(screen.getByText('No viewpoints yet')).toBeInTheDocument()
  })

  it('shows a load error for an unknown lot', async () => {
    mockFetch({
      'GET /lots/nope': { status: 404, body: { error: 'not_found', message: 'Lot not found' } },
      'GET /admin/lots/nope/layout/draft': { status: 404, body: { error: 'not_found', message: 'Lot not found' } },
    })
    renderApp('/admin/lots/nope/map', ADMIN)
    expect(await screen.findByRole('alert')).toHaveTextContent('Lot not found')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  // US-07 #7: Save stores the draft on the server with its revision.
  it('Save sends the draft and its revision', async () => {
    const draft = draftFixture({ revision: 4 })
    const fetchMock = mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draft },
      [`PUT ${URL}`]: { body: { ...draft, revision: 5, updatedBy: 'admin@example.edu' } },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    expect(await screen.findByText('Revision 4')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Draft saved')).toBeInTheDocument()
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual(toDraftUpdate(draft))
  })

  // US-07 #7: a save against an older revision is refused and the page asks for a reload.
  it('a stale save shows the message and Reload fetches the latest draft', async () => {
    let gets = 0
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: () => ({ body: draftFixture({ revision: gets++ === 0 ? 0 : 2 }) }),
      [`PUT ${URL}`]: { status: 409, body: { error: 'stale_revision', message: STALE } },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(STALE)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(await screen.findByText('Revision 2')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('shows other save errors', async () => {
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { status: 422, body: { error: 'validation_error', message: 'Invalid request' } },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request')
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument()
  })

  it('sends a signed-out visitor to sign in', async () => {
    mockFetch({})
    renderApp('/admin/lots/test-lot/map')
    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/signin/))
  })
})

describe('Admin home Map link', () => {
  it('points at the picked lot', async () => {
    localStorage.setItem('parking.admin.lotId', 'north-lot')
    mockFetch({})
    renderApp('/admin', ADMIN)
    expect(await screen.findByRole('link', { name: 'Map' })).toHaveAttribute('href', '/admin/lots/north-lot/map')
  })

  it('falls back to the first lot', async () => {
    mockFetch({ 'GET /lots': { body: [lotItem('test-lot'), lotItem('zeta')] } })
    renderApp('/admin', ADMIN)
    expect(await screen.findByRole('link', { name: 'Map' })).toHaveAttribute('href', '/admin/lots/test-lot/map')
  })

  it('is disabled when there are no lots', async () => {
    mockFetch({ 'GET /lots': { body: [] } })
    renderApp('/admin', ADMIN)
    expect(await screen.findByText('(no lots yet)')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Map' })).not.toBeInTheDocument()
  })

  it('opens the mapping page', async () => {
    localStorage.setItem('parking.admin.lotId', 'test-lot')
    mockFetch({ 'GET /lots/test-lot': { body: detail }, [`GET ${URL}`]: { body: draftFixture() } })
    renderApp('/admin', ADMIN)
    await userEvent.click(await screen.findByRole('link', { name: 'Map' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/lots/test-lot/map')
    await waitFor(() => expect(heading()).toHaveTextContent('Lot Mapping · Test Lot'))
  })
})
