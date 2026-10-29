import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LotDetail } from '../api/schemas'
import { dateTime } from '../lib/relativeTime'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'
import { draftFixture } from './fixtures/kevin'
import type { LayoutVersionOut } from './types'

const VERSIONS = '/admin/lots/test-lot/layout/versions'
const DRAFT = '/admin/lots/test-lot/layout/draft'

const detail: LotDetail = {
  lot: { lotId: 'test-lot', name: 'Test Lot', location: 'x', staleAfterMinutes: 30 },
  viewpoints: [],
  layout: { version: 4, schematic: { width: 1000, height: 600 }, spaces: [] },
}

const versions: LayoutVersionOut[] = [
  { version: 4, publishedBy: 'kevin@example.edu', publishedAt: '2026-10-28T15:00:00Z' },
  { version: 3, publishedBy: 'admin@example.edu', publishedAt: '2026-10-27T09:30:00Z' },
  { version: 1, publishedBy: 'seed', publishedAt: '2026-10-01T12:00:00Z' },
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

const rows = () => screen.getAllByRole('row').slice(1)

describe('VersionsPage', () => {
  // US-09 #6: each version with who published it and when, newest first.
  it('lists versions newest first with who and when', async () => {
    mockFetch({ 'GET /lots/test-lot': { body: detail }, [`GET ${VERSIONS}`]: { body: versions } })
    renderApp('/admin/lots/test-lot/versions', ADMIN)
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Versions · Test Lot')
    const cells = rows().map((r) =>
      within(r)
        .getAllByRole('cell')
        .slice(0, 3)
        .map((c) => c.textContent),
    )
    expect(cells).toEqual([
      ['v4 Live', 'kevin@example.edu', dateTime('2026-10-28T15:00:00Z')],
      ['v3', 'admin@example.edu', dateTime('2026-10-27T09:30:00Z')],
      ['v1', 'seed', dateTime('2026-10-01T12:00:00Z')],
    ])
    expect(screen.getByRole('link', { name: '← Lot Mapping' })).toHaveAttribute('href', '/admin/lots/test-lot/map')
  })

  it('says when nothing is published', async () => {
    mockFetch({
      'GET /lots/draft': { status: 404, body: { error: 'not_found', message: 'Lot not found' } },
      'GET /admin/lots/draft/layout/versions': { body: [] },
    })
    renderApp('/admin/lots/draft/versions', ADMIN)
    expect(await screen.findByText('Nothing published yet.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Versions · draft')
  })

  it('shows a load error', async () => {
    mockFetch({
      'GET /lots/nope': { status: 404, body: { error: 'not_found', message: 'Lot not found' } },
      'GET /admin/lots/nope/layout/versions': { status: 404, body: { error: 'not_found', message: 'Lot not found' } },
    })
    renderApp('/admin/lots/nope/versions', ADMIN)
    expect(await screen.findByRole('alert')).toHaveTextContent('Lot not found')
  })

  // US-09 #7: Restore v3 loads it into the draft and returns to the mapping page with a note.
  it('Restore loads the version into the draft and returns to the mapping page', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const restored = draftFixture({ revision: 9, basedOnVersion: 3 })
    const fetchMock = mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${VERSIONS}`]: { body: versions },
      [`POST ${VERSIONS}/3/restore`]: { body: restored },
      [`GET ${DRAFT}`]: { body: restored },
      [`PUT ${DRAFT}`]: { body: { ...restored, revision: 10 } },
    })
    renderApp('/admin/lots/test-lot/versions', ADMIN)
    await userEvent.click(await screen.findByRole('button', { name: 'Restore v3' }))

    expect(confirm).toHaveBeenCalledWith('Replace the draft with v3? Draft changes that are not published will be lost.')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/admin/lots/test-lot/map'))
    expect(await screen.findByText('Draft restored from v3. Publish to make it live.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Draft based on v3'))
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/versions/3/restore') && init?.method === 'POST')).toBe(
      true,
    )
    // The note stays until the next save, which shows the usual "Draft saved".
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Draft saved')).toBeInTheDocument()
    expect(screen.queryByText(/Draft restored from v3/)).not.toBeInTheDocument()
  })

  it('does nothing when the restore is not confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchMock = mockFetch({ 'GET /lots/test-lot': { body: detail }, [`GET ${VERSIONS}`]: { body: versions } })
    renderApp('/admin/lots/test-lot/versions', ADMIN)
    await userEvent.click(await screen.findByRole('button', { name: 'Restore v3' }))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/lots/test-lot/versions')
  })

  it('shows a restore error and stays on the page', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${VERSIONS}`]: { body: versions },
      [`POST ${VERSIONS}/3/restore`]: {
        status: 409,
        body: { error: 'stale_revision', message: 'This draft changed in another window. Reload to see the latest.' },
      },
    })
    renderApp('/admin/lots/test-lot/versions', ADMIN)
    await userEvent.click(await screen.findByRole('button', { name: 'Restore v3' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This draft changed in another window.')
    expect(screen.getByRole('button', { name: 'Restore v3' })).toBeEnabled()
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/lots/test-lot/versions')
  })

  it('sends a signed-out visitor to sign in', async () => {
    mockFetch({})
    renderApp('/admin/lots/test-lot/versions')
    await waitFor(() => expect(screen.getByTestId('location').textContent).toMatch(/^\/signin/))
  })
})
