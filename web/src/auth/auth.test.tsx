import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSession } from './session'
import { ADMIN, mockFetch, renderApp } from '../test/helpers'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('RequireAdmin', () => {
  it('redirects to /signin with next and returns there after login', async () => {
    mockFetch({
      'POST /auth/login': { body: { ...ADMIN } },
      'GET /lots': { body: [] },
    })
    renderApp('/admin/upload')
    expect(screen.getByTestId('location')).toHaveTextContent('/signin?next=%2Fadmin%2Fupload')

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'admin@example.edu')
    await user.type(screen.getByLabelText('Password'), 'pw')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Upload photo' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/upload')
    expect(loadSession()?.token).toBe('tok-admin')
  })

  it('shows the wrong-password message on 401', async () => {
    mockFetch({ 'POST /auth/login': { status: 401, body: { error: 'invalid_credentials', message: 'nope' } } })
    renderApp('/signin')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'a@b.c')
    await user.type(screen.getByLabelText('Password'), 'bad')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Email or password is incorrect')).toBeInTheDocument()
  })

  it('tells a non-admin they have no access and shows no admin controls', () => {
    mockFetch({})
    renderApp('/admin', { ...ADMIN, groups: ['viewer'] })
    expect(screen.getByText('You do not have admin access')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Upload' })).toBeNull()
  })

  it('signs out and redirects on session_expired', async () => {
    mockFetch({
      'GET /lots': { status: 401, body: { error: 'session_expired', message: 'Session expired' } },
    })
    renderApp('/admin/upload', ADMIN)
    expect(await screen.findByText('Your session expired. Please sign in again')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/signin?next=%2Fadmin%2Fupload')
    expect(loadSession()).toBeNull()
  })

  it('attaches the bearer token to API calls', async () => {
    const fetchMock = mockFetch({ 'GET /lots': { body: [] } })
    renderApp('/admin/upload', ADMIN)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-admin')
  })

  it('sign out clears the session and goes home', async () => {
    mockFetch({ 'GET /lots': { body: [] } })
    renderApp('/admin', ADMIN)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }))
    expect(loadSession()).toBeNull()
    await vi.waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
  })
})
