import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { vi } from 'vitest'
import { AppRoutes } from '../App'
import { saveSession, type Session } from '../auth/session'

export const ADMIN: Session = {
  token: 'tok-admin',
  email: 'admin@example.edu',
  groups: ['admin'],
  expiresAt: '2099-01-01T00:00:00Z',
}

type Reply = { status?: number; body: unknown }
/**
 * A fixed reply, or a function of the request; a function may return a promise to hold the
 * response, or throw to simulate a network failure.
 */
type Handler = Reply | ((init?: RequestInit) => Reply | Promise<Reply>)

/** Local-dev sign-in, answered by default so sign-in tests only mock what they care about. */
export const DEV_AUTH_CONFIG: Reply = { body: { mode: 'dev', region: null, userPoolClientId: null } }

/**
 * Install a fetch mock keyed by "METHOD /path" (path after API_BASE). Absolute URLs off the API
 * (e.g. "POST https://cognito-idp.us-east-1.amazonaws.com/") are keyed as-is.
 */
export function mockFetch(routes: Record<string, Handler>) {
  routes = { 'GET /auth/config': DEV_AUTH_CONFIG, ...routes }
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^\/api/, '')
    const key = `${init?.method ?? 'GET'} ${url}`
    const h = routes[key]
    if (!h) return new Response(JSON.stringify({ error: 'not_found', message: `No mock for ${key}` }), { status: 404 })
    const { status = 200, body } = typeof h === 'function' ? await h(init) : h
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** An unsigned JWT carrying these claims; the client reads claims but never checks signatures. */
export function fakeIdToken(claims: Record<string, unknown>): string {
  const b64url = (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname + loc.search}</div>
}

/** A promise plus its resolver, for holding a mocked response until the test releases it. */
export function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Mount the app at `path`; `extra` renders inside the router (e.g. a navigation trigger). */
export function renderApp(path: string, session?: Session, extra?: ReactNode) {
  if (session) saveSession(session)
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
      <LocationProbe />
      {extra}
    </MemoryRouter>,
  )
}
