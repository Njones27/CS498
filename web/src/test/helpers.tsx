import { render } from '@testing-library/react'
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

type Handler = { status?: number; body: unknown } | ((init?: RequestInit) => { status?: number; body: unknown })

/** Install a fetch mock keyed by "METHOD /path" (path after API_BASE). */
export function mockFetch(routes: Record<string, Handler>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^\/api/, '')
    const key = `${init?.method ?? 'GET'} ${url}`
    const h = routes[key]
    if (!h) return new Response(JSON.stringify({ error: 'not_found', message: `No mock for ${key}` }), { status: 404 })
    const { status = 200, body } = typeof h === 'function' ? h(init) : h
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname + loc.search}</div>
}

export function renderApp(path: string, session?: Session) {
  if (session) saveSession(session)
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  )
}
