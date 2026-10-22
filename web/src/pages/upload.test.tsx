import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LotDetail, LotListItem } from '../api/schemas'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'
import { readCaptureTime } from '../lib/exif'
import { putFile } from '../lib/putFile'

vi.mock('../lib/exif', () => ({ readCaptureTime: vi.fn() }))
vi.mock('../lib/putFile', () => ({ putFile: vi.fn() }))

const lots: LotListItem[] = [
  {
    lotId: 'lot-a', name: 'Lot A', location: 'x', staleAfterMinutes: 15, layoutVersion: 1,
    summary: { free: 0, occupied: 0, unknown: 0, closed: 0, total: 0, openPercent: null, hasRecentData: false, isStale: false },
  },
]
const detail: LotDetail = {
  lot: { lotId: 'lot-a', name: 'Lot A', location: 'x', staleAfterMinutes: 15 },
  viewpoints: [{ viewId: 'v1', name: 'East pole' }],
  layout: { version: 1, schematic: { width: 10, height: 10 }, spaces: [] },
}

const jpeg = (size = 1024) => {
  const f = new File(['x'], 'lot.jpg', { type: 'image/jpeg' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

beforeEach(() => {
  localStorage.setItem('parking.admin.lotId', 'lot-a')
  vi.mocked(readCaptureTime).mockResolvedValue(new Date('2026-10-21T09:30:00'))
  vi.mocked(putFile).mockResolvedValue()
})
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

async function setup(routes: Parameters<typeof mockFetch>[0] = {}) {
  const fetchMock = mockFetch({ 'GET /lots': { body: lots }, 'GET /lots/lot-a': { body: detail }, ...routes })
  renderApp('/admin/upload', ADMIN)
  await screen.findByRole('option', { name: 'East pole' })
  return { fetchMock, user: userEvent.setup({ applyAccept: false }) }
}

const fileInput = () => screen.getByLabelText('Photo') as HTMLInputElement
const uploadButton = () => screen.getByRole('button', { name: 'Upload' })

describe('upload validation', () => {
  it('rejects non-JPEG/PNG files', async () => {
    const { user } = await setup()
    await user.upload(fileInput(), new File(['x'], 'a.heic', { type: 'image/heic' }))
    expect(await screen.findByText('Only JPEG or PNG photos are accepted')).toBeInTheDocument()
    expect(uploadButton()).toBeDisabled()
  })

  it('rejects files over 15 MB', async () => {
    const { user } = await setup()
    await user.upload(fileInput(), jpeg(15 * 1024 * 1024 + 1))
    expect(await screen.findByText('Photos must be 15 MB or smaller')).toBeInTheDocument()
    expect(uploadButton()).toBeDisabled()
  })

  it('prefills the EXIF time and disables Upload when the photo has none', async () => {
    vi.mocked(readCaptureTime).mockResolvedValue(null)
    const { user } = await setup()
    await user.upload(fileInput(), jpeg())
    expect(await screen.findByText(/has no capture time/)).toBeInTheDocument()
    expect(screen.getByLabelText('Capture time')).toHaveValue('')
    expect(uploadButton()).toBeDisabled()
  })

  it('blocks a future capture time without calling the API', async () => {
    const { fetchMock, user } = await setup()
    await user.upload(fileInput(), jpeg())
    const time = screen.getByLabelText('Capture time')
    await vi.waitFor(() => expect((time as HTMLInputElement).value).toMatch(/^2026-10-21T09:30/))
    await user.clear(time)
    await user.type(time, '2999-01-01T10:00:00')
    await user.click(uploadButton())
    expect(await screen.findByText('Capture time cannot be in the future')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/admin/uploads'))).toBe(false)
  })
})

describe('upload flow', () => {
  it('requests a slot, PUTs the file, completes, and confirms', async () => {
    let requestBody: Record<string, unknown> = {}
    const { user } = await setup({
      'POST /admin/uploads': (init) => {
        requestBody = JSON.parse(String(init?.body))
        return { body: { imageId: 'img-1', uploadUrl: 'http://s3/put', expiresAt: '2099-01-01T00:00:00Z' } }
      },
      'POST /admin/uploads/img-1/complete': { body: { imageId: 'img-1', jobStatus: 'QUEUED' } },
    })
    await user.upload(fileInput(), jpeg())
    await vi.waitFor(() => expect(uploadButton()).toBeEnabled())
    await user.click(uploadButton())
    expect(await screen.findByText('Photo queued for processing')).toBeInTheDocument()
    expect(requestBody).toMatchObject({
      lotId: 'lot-a', viewId: 'v1', contentType: 'image/jpeg', sizeBytes: 1024,
      captureTime: new Date('2026-10-21T09:30:00').toISOString(),
    })
    expect(requestBody.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(putFile).toHaveBeenCalledWith('http://s3/put', expect.any(File), expect.any(Function))
  })

  it('explains a 409 duplicate and links to the original snapshot', async () => {
    const { user } = await setup({
      'POST /admin/uploads': {
        status: 409,
        body: { error: 'duplicate', message: 'Duplicate', originalImageId: 'img-0', uploadedAt: '2026-10-21T15:00:00Z' },
      },
    })
    await user.upload(fileInput(), jpeg())
    await vi.waitFor(() => expect(uploadButton()).toBeEnabled())
    await user.click(uploadButton())
    expect(await screen.findByText(/This photo was already uploaded on Oct 21/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View the original' })).toHaveAttribute('href', '/admin/snapshots#img-0')
    expect(putFile).not.toHaveBeenCalled()
  })

  it('shows the server message for other errors', async () => {
    const { user } = await setup({
      'POST /admin/uploads': { status: 422, body: { error: 'validation', message: 'Unknown viewpoint' } },
    })
    await user.upload(fileInput(), jpeg())
    await vi.waitFor(() => expect(uploadButton()).toBeEnabled())
    await user.click(uploadButton())
    expect(await screen.findByText('Unknown viewpoint')).toBeInTheDocument()
  })
})
