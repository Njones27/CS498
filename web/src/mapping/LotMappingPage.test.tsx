import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LotDetail, LotListItem } from '../api/schemas'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'
import { draftFixture } from './fixtures/kevin'
import type { ValidationReport } from './types'
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
    expect(screen.getByRole('button', { name: 'Validate' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled()
    expect(screen.getByRole('link', { name: 'Versions' })).toHaveAttribute('href', '/admin/lots/test-lot/versions')
    expect(screen.getByRole('region', { name: 'Validation' })).toHaveTextContent('Press Validate')
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

  it('toggles autosave and persists setting to localStorage', async () => {
    mockFetch({ 'GET /lots/test-lot': { body: detail }, [`GET ${URL}`]: { body: draftFixture() } })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    const toggle = (await screen.findByRole('checkbox', { name: 'Autosave' })) as HTMLInputElement
    expect(toggle.checked).toBe(false)

    await userEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    expect(localStorage.getItem('parking.autosave')).toBe('true')

    await userEvent.click(toggle)
    expect(toggle.checked).toBe(false)
    expect(localStorage.getItem('parking.autosave')).toBe('false')
  })

  it('supports undo and redo buttons for layout edits', async () => {
    mockFetch({ 'GET /lots/test-lot': { body: detail }, [`GET ${URL}`]: { body: draftFixture() } })
    renderApp('/admin/lots/test-lot/map', ADMIN)

    const undoBtn = await screen.findByRole('button', { name: 'Undo' })
    const redoBtn = screen.getByRole('button', { name: 'Redo' })
    expect(undoBtn).toBeDisabled()
    expect(redoBtn).toBeDisabled()

    // Add a new viewpoint to trigger an edit
    await userEvent.click(await screen.findByRole('button', { name: '+ Viewpoint' }))
    const nameInput = screen.getByPlaceholderText('e.g. South Corner')
    await userEvent.type(nameInput, 'Gate View')
    await userEvent.click(screen.getByRole('button', { name: 'Add Viewpoint' }))

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(undoBtn).toBeEnabled()
    expect(redoBtn).toBeDisabled()

    // Undo the addition
    await userEvent.click(undoBtn)
    expect(undoBtn).toBeDisabled()
    expect(redoBtn).toBeEnabled()

    // Redo the addition
    await userEvent.click(redoBtn)
    expect(undoBtn).toBeEnabled()
    expect(redoBtn).toBeDisabled()
  })

  it('supports keyboard shortcuts for undo (Ctrl+Z) and redo (Ctrl+Y)', async () => {
    mockFetch({ 'GET /lots/test-lot': { body: detail }, [`GET ${URL}`]: { body: draftFixture() } })
    renderApp('/admin/lots/test-lot/map', ADMIN)

    const undoBtn = await screen.findByRole('button', { name: 'Undo' })
    const redoBtn = screen.getByRole('button', { name: 'Redo' })

    // Add viewpoint to make draft dirty
    await userEvent.click(await screen.findByRole('button', { name: '+ Viewpoint' }))
    await userEvent.type(screen.getByPlaceholderText('e.g. South Corner'), 'Gate View')
    await userEvent.click(screen.getByRole('button', { name: 'Add Viewpoint' }))
    expect(undoBtn).toBeEnabled()

    // Ctrl+Z undoes
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(undoBtn).toBeDisabled()
    expect(redoBtn).toBeEnabled()

    // Ctrl+Y redoes
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    expect(undoBtn).toBeEnabled()
    expect(redoBtn).toBeDisabled()

    // Ctrl+Shift+Z also redoes
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(undoBtn).toBeDisabled()
    expect(redoBtn).toBeEnabled()
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(undoBtn).toBeEnabled()
    expect(redoBtn).toBeDisabled()
  })

  it('does not trigger undo/redo shortcuts when typing inside an input element', async () => {
    mockFetch({ 'GET /lots/test-lot': { body: detail }, [`GET ${URL}`]: { body: draftFixture() } })
    renderApp('/admin/lots/test-lot/map', ADMIN)

    const undoBtn = await screen.findByRole('button', { name: 'Undo' })

    // Make an edit first
    await userEvent.click(await screen.findByRole('button', { name: '+ Viewpoint' }))
    const input = screen.getByPlaceholderText('e.g. South Corner')
    await userEvent.type(input, 'Gate View')
    await userEvent.click(screen.getByRole('button', { name: 'Add Viewpoint' }))
    expect(undoBtn).toBeEnabled()

    // Open add viewpoint dialog again and press Ctrl+Z while input is focused
    await userEvent.click(screen.getByRole('button', { name: '+ Viewpoint' }))
    const nextInput = screen.getByPlaceholderText('e.g. South Corner')
    nextInput.focus()

    fireEvent.keyDown(nextInput, { key: 'z', ctrlKey: true })
    // Undo was not triggered, button is still enabled
    expect(undoBtn).toBeEnabled()
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

const VALIDATE = `POST ${URL}/validate`
const PUBLISH = 'POST /admin/lots/test-lot/layout/publish'

/** Sketch 6: one error and one warning, compared with v3. */
function report(over: Partial<ValidationReport> = {}): ValidationReport {
  return {
    ok: false,
    comparedWith: 3,
    diff: { added: [], retired: ['A-03'], changed: ['A-01'] },
    errors: [{ code: 'duplicate_label', message: 'Two spaces share the label B-04', spaceIds: ['A-02', 'A-01'], viewId: null }],
    warnings: [
      {
        code: 'unmapped_spaces',
        message: '1 space has no polygon in any view: it will show UNKNOWN',
        spaceIds: ['A-02'],
        viewId: null,
      },
    ],
    ...over,
  }
}

const WARNINGS_ONLY = report({ ok: true, errors: [] })

/** Issue messages also show in the editor's space tooltips, so look for them in the panel. */
const validationPanel = () => screen.getByRole('region', { name: 'Validation' })

/** The method and path of each fetch call, in order. */
function calls(fetchMock: ReturnType<typeof mockFetch>): string[] {
  return fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace(/^\/api/, '')}`)
}

function savedDraft(revision: number, basedOnVersion = 1) {
  return draftFixture({ revision, basedOnVersion, updatedBy: 'admin@example.edu' })
}

describe('Validate (US-09 #1)', () => {
  it('saves the draft, then lists errors (x) and warnings (!) as in Sketch 6', async () => {
    const fetchMock = mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { body: savedDraft(1) },
      [VALIDATE]: { body: report() },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }))

    const panel = await screen.findByRole('region', { name: 'Validation' })
    await waitFor(() => expect(panel).toHaveTextContent('Draft compared with v3'))
    expect(calls(fetchMock).filter((c) => !c.startsWith('GET'))).toEqual([`PUT ${URL}`, VALIDATE])
    const items = within(panel).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('xError: Two spaces share the label B-04 · A-02, A-01blocks publish')
    expect(items[1]).toHaveTextContent('!Warning: 1 space has no polygon in any view: it will show UNKNOWN · A-02')
    expect(items[1]).not.toHaveTextContent('blocks publish')
    expect(panel).toHaveTextContent('Spaces: 1 retired, 1 changed')
    expect(screen.getByText('Draft saved')).toBeInTheDocument() // Validate saved first (useDraftLayout's note)
  })

  it('clicking an issue selects its first space, and errors reach both panels', async () => {
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { body: savedDraft(1) },
      [VALIDATE]: { body: report() },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    const photoOutline = () => screen.getByTestId('space-polygon-A-01').querySelector('polygon')
    expect(screen.getByTestId('schematic-space-A-01')).not.toHaveClass('schematic-space--error')
    expect(photoOutline()).not.toHaveAttribute('stroke', 'var(--nearly-full)')
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await userEvent.click(await screen.findByRole('button', { name: /Two spaces share the label B-04/ }))

    // The error's spaces are outlined in the editor (brief §4.4 `issues`), and the first is selected.
    expect(screen.getByTestId('schematic-space-A-01')).toHaveClass('schematic-space--error')
    expect(screen.getByTestId('schematic-space-A-02')).toHaveClass('schematic-space--error')
    expect(screen.getByTestId('schematic-space-A-02')).toHaveAttribute('aria-pressed', 'true')
    const selected = screen.getByRole('group', { name: 'Selected space' })
    expect(selected).toHaveTextContent('Selected A-02')
    expect(selected).toHaveTextContent('Two spaces share the label B-04')
    // Only errors go to the editor; the warning on A-02 stays in the validation panel.
    expect(selected).not.toHaveTextContent('no polygon in any view')
    // The reference photo panel gets the same errors: A-01's outline on V1 turns red.
    expect(photoOutline()).toHaveAttribute('stroke', 'var(--nearly-full)')
  })

  it('says so when there are no problems', async () => {
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { body: savedDraft(1) },
      [VALIDATE]: {
        body: report({ ok: true, errors: [], warnings: [], comparedWith: null, diff: { added: [], retired: [], changed: [] } }),
      },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }))
    const panel = screen.getByRole('region', { name: 'Validation' })
    await waitFor(() => expect(panel).toHaveTextContent('No problems found.'))
    expect(panel).toHaveTextContent('Nothing published yet')
  })

  it('does not validate when the save is stale', async () => {
    const fetchMock = mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { status: 409, body: { error: 'stale_revision', message: STALE } },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(STALE)
    expect(calls(fetchMock)).not.toContain(VALIDATE)
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
  })
})

describe('Publish (US-09 #2, #4)', () => {
  // US-09 #2: the button stays disabled until every error is fixed.
  it('is disabled while the last report has errors', async () => {
    let reports = 0
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { body: savedDraft(1) },
      [VALIDATE]: () => ({ body: reports++ === 0 ? report() : WARNINGS_ONLY }),
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await within(validationPanel()).findByText(/Two spaces share the label B-04/)
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()

    // US-09 #3: warnings alone don't block.
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await waitFor(() => expect(within(validationPanel()).queryByText(/Two spaces share/)).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled()
    // A warnings-only report outlines nothing in the editor.
    expect(screen.getByTestId('schematic-space-A-02')).not.toHaveClass('schematic-space--error')
  })

  // The report describes the revision it checked, so an edit (which may fix the error) clears it.
  it('an edit clears the last report, so it no longer blocks Publish', async () => {
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { body: savedDraft(1) },
      [VALIDATE]: { body: report() },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await userEvent.click(await screen.findByRole('button', { name: /Two spaces share the label B-04/ }))
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
    expect(screen.getByTestId('schematic-space-A-02')).toHaveClass('schematic-space--error')

    const label = within(screen.getByRole('group', { name: 'Selected space' })).getByLabelText('Label')
    await userEvent.clear(label)
    await userEvent.type(label, 'B-05')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled()
    expect(screen.getByTestId('schematic-space-A-02')).not.toHaveClass('schematic-space--error')
    expect(validationPanel()).toHaveTextContent('Press Validate')
  })

  it('saves first, publishes that revision, then shows the new version', async () => {
    let gets = 0
    const fetchMock = mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: () => ({ body: gets++ === 0 ? draftFixture({ basedOnVersion: 3 }) : savedDraft(6, 4) }),
      [`PUT ${URL}`]: { body: savedDraft(5, 3) },
      [PUBLISH]: { status: 201, body: { version: 4, publishedBy: 'admin@example.edu', publishedAt: '2026-10-28T15:00:00Z' } },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await waitFor(() => expect(heading()).toHaveTextContent('Draft based on v3'))
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))

    expect(await screen.findByText('Published v4')).toBeInTheDocument()
    await waitFor(() => expect(heading()).toHaveTextContent('Draft based on v4'))
    const writes = calls(fetchMock).filter((c) => !c.startsWith('GET'))
    expect(writes).toEqual([`PUT ${URL}`, PUBLISH])
    const publish = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/layout/publish'))
    expect(JSON.parse(String(publish?.[1]?.body))).toEqual({ revision: 5 })
  })

  it('shows the report when the server refuses with validation_failed', async () => {
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { body: savedDraft(1) },
      [PUBLISH]: {
        status: 409,
        body: { error: 'validation_failed', message: 'Fix the errors in the validation report before publishing.', report: report() },
      },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Fix the errors in the validation report before publishing.')
    expect(within(validationPanel()).getByText(/Two spaces share the label B-04/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
  })

  it('a stale publish asks to reload', async () => {
    let gets = 0
    mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: () => ({ body: draftFixture({ revision: gets++ === 0 ? 0 : 7 }) }),
      [`PUT ${URL}`]: { body: savedDraft(1) },
      [PUBLISH]: { status: 409, body: { error: 'stale_revision', message: STALE } },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(STALE)
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(await screen.findByText('Revision 7')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled()
  })

  it('does not publish when the save fails', async () => {
    const fetchMock = mockFetch({
      'GET /lots/test-lot': { body: detail },
      [`GET ${URL}`]: { body: draftFixture() },
      [`PUT ${URL}`]: { status: 422, body: { error: 'validation_error', message: 'Invalid request' } },
    })
    renderApp('/admin/lots/test-lot/map', ADMIN)
    await screen.findByText('Revision 0')
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request')
    expect(calls(fetchMock)).not.toContain(PUBLISH)
  })
})
