import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNavigate } from 'react-router-dom'
import { loadSession, peekFlash, saveSession } from './session'
import { ADMIN, deferred, fakeIdToken, mockFetch, renderApp } from '../test/helpers'

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

  it('ignores a late session_expired once the user has signed in again', async () => {
    const reply = deferred<{ status: number; body: unknown }>()
    mockFetch({ 'GET /lots': () => reply.promise })
    renderApp('/admin/upload', ADMIN)
    // The user re-authenticates (e.g. in another flow) while the old request is still in flight.
    saveSession({ ...ADMIN, token: 'tok-new' })
    await act(async () => reply.resolve({ status: 401, body: { error: 'session_expired', message: 'x' } }))

    expect(loadSession()?.token).toBe('tok-new')
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/upload$/)
    expect(screen.queryByText('Your session expired. Please sign in again')).toBeNull()
  })

  it('does not redirect /signin to itself on a late session_expired', async () => {
    function GoToSignIn() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/signin')}>go sign in</button>
    }
    const reply = deferred<{ status: number; body: unknown }>()
    mockFetch({ 'GET /lots': () => reply.promise })
    renderApp('/', ADMIN, <GoToSignIn />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'go sign in' }))
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/signin$/)
    await act(async () => reply.resolve({ status: 401, body: { error: 'session_expired', message: 'x' } }))

    expect(loadSession()).toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/signin$/)
    expect(peekFlash()).toBeNull()
  })
})

describe('Cognito sign-in', () => {
  const COGNITO = 'POST https://cognito-idp.us-east-1.amazonaws.com/'
  const CONFIG = { body: { mode: 'cognito', region: 'us-east-1', userPoolClientId: 'client-123' } }
  const ID_TOKEN = fakeIdToken({ email: 'admin@example.edu', 'cognito:groups': ['admin'], exp: 4102444800 })
  const cognitoError = (type: string, message: string) => ({ status: 400, body: { __type: type, message } })

  async function signIn(email = 'admin@example.edu', password = 'Secret-pw1') {
    const user = userEvent.setup()
    await user.clear(screen.getByLabelText('Email'))
    await user.type(screen.getByLabelText('Email'), email)
    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), password)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
  }

  const calls = (fetchMock: ReturnType<typeof mockFetch>, url: string) =>
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith(url))

  it('signs in at the user pool and sends the ID token to the API', async () => {
    const fetchMock = mockFetch({
      'GET /auth/config': CONFIG,
      [COGNITO]: { body: { AuthenticationResult: { IdToken: ID_TOKEN, AccessToken: 'access', ExpiresIn: 3600 } } },
      'GET /lots': { body: [] },
    })
    renderApp('/admin/upload')
    await signIn()

    expect(await screen.findByRole('heading', { name: 'Upload photo' })).toBeInTheDocument()
    const [[url, init]] = calls(fetchMock, 'amazonaws.com/')
    expect(url).toBe('https://cognito-idp.us-east-1.amazonaws.com/')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    })
    expect(JSON.parse(init?.body as string)).toEqual({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: 'client-123',
      AuthParameters: { USERNAME: 'admin@example.edu', PASSWORD: 'Secret-pw1' },
    })
    expect(calls(fetchMock, '/auth/login')).toHaveLength(0)
    // The password goes to the user pool only.
    const toApi = fetchMock.mock.calls.filter(([input]) => !String(input).startsWith('https://cognito-idp.'))
    expect(toApi.some(([, i]) => String(i?.body ?? '').includes('Secret-pw1'))).toBe(false)

    expect(loadSession()).toEqual({
      token: ID_TOKEN,
      email: 'admin@example.edu',
      groups: ['admin'],
      expiresAt: '2100-01-01T00:00:00.000Z',
    })
    await vi.waitFor(() => expect(calls(fetchMock, '/lots')).not.toHaveLength(0))
    const lotsInit = calls(fetchMock, '/lots')[0][1] as RequestInit
    expect((lotsInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${ID_TOKEN}`)
  })

  it('tells a user outside the admin group they have no access', async () => {
    const token = fakeIdToken({ email: 'driver@example.edu', exp: 4102444800 })
    mockFetch({ 'GET /auth/config': CONFIG, [COGNITO]: { body: { AuthenticationResult: { IdToken: token } } } })
    renderApp('/admin')
    await signIn('driver@example.edu')
    expect(await screen.findByText('You do not have admin access')).toBeInTheDocument()
    expect(loadSession()?.groups).toEqual([])
  })

  it('shows the wrong-password message and fetches the config only once', async () => {
    const fetchMock = mockFetch({
      'GET /auth/config': CONFIG,
      [COGNITO]: cognitoError('com.amazonaws.cognito.identity.idp.model#NotAuthorizedException', 'Incorrect username or password.'),
    })
    renderApp('/signin')
    await signIn()
    expect(await screen.findByText('Email or password is incorrect')).toBeInTheDocument()
    await signIn()
    await vi.waitFor(() => expect(calls(fetchMock, 'amazonaws.com/')).toHaveLength(2))
    expect(calls(fetchMock, '/auth/config')).toHaveLength(1)
    expect(loadSession()).toBeNull()
  })

  it('treats an unknown user like a wrong password', async () => {
    mockFetch({ 'GET /auth/config': CONFIG, [COGNITO]: cognitoError('UserNotFoundException', 'User does not exist.') })
    renderApp('/signin')
    await signIn()
    expect(await screen.findByText('Email or password is incorrect')).toBeInTheDocument()
  })

  it.each([
    ['a NEW_PASSWORD_REQUIRED challenge', { body: { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' } }],
    ['a required password reset', cognitoError('PasswordResetRequiredException', 'Password reset required for the user')],
  ])('asks for an administrator on %s', async (_, reply) => {
    mockFetch({ 'GET /auth/config': CONFIG, [COGNITO]: reply })
    renderApp('/signin')
    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account needs a new password before it can sign in. Ask an administrator to set one.',
    )
    expect(loadSession()).toBeNull()
  })

  it('explains a lockout after too many attempts', async () => {
    mockFetch({ 'GET /auth/config': CONFIG, [COGNITO]: cognitoError('NotAuthorizedException', 'Password attempts exceeded') })
    renderApp('/signin')
    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many failed sign-in attempts. Wait a few minutes and try again.',
    )
  })

  it.each([
    ['a network failure', () => {
      throw new TypeError('Failed to fetch')
    }],
    ['an unexpected error type', cognitoError('InternalErrorException', 'boom')],
    ['an ID token without an email', { body: { AuthenticationResult: { IdToken: fakeIdToken({ exp: 4102444800 }) } } }],
  ])('says sign-in is unavailable on %s', async (_, reply) => {
    mockFetch({ 'GET /auth/config': CONFIG, [COGNITO]: reply })
    renderApp('/signin')
    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is unavailable right now. Try again in a moment.')
    expect(loadSession()).toBeNull()
  })

  it('says sign-in is unavailable when the pool is not configured', async () => {
    const fetchMock = mockFetch({ 'GET /auth/config': { body: { mode: 'cognito', region: 'us-east-1', userPoolClientId: null } } })
    renderApp('/signin')
    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is unavailable right now. Try again in a moment.')
    expect(calls(fetchMock, 'amazonaws.com/')).toHaveLength(0)
    expect(calls(fetchMock, '/auth/login')).toHaveLength(0)
  })

  it('surfaces a config failure and fetches it again on the next try', async () => {
    let configCalls = 0
    const fetchMock = mockFetch({
      'GET /auth/config': () => (++configCalls === 1 ? { status: 503, body: { error: 'unavailable', message: 'x' } } : CONFIG),
      [COGNITO]: { body: { AuthenticationResult: { IdToken: ID_TOKEN } } },
      'GET /lots': { body: [] },
    })
    renderApp('/signin?next=%2Fadmin%2Fupload')
    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is unavailable right now. Try again in a moment.')
    expect(calls(fetchMock, 'amazonaws.com/')).toHaveLength(0)

    await signIn()
    expect(await screen.findByRole('heading', { name: 'Upload photo' })).toBeInTheDocument()
    expect(configCalls).toBe(2)
    expect(loadSession()?.token).toBe(ID_TOKEN)
  })
})
