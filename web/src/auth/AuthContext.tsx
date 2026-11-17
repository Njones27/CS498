import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, setSessionExpiredHandler, setTokenGetter } from '../api/client'
import type { AuthConfigResponse, LoginRequest, LoginResponse } from '../api/schemas'
import { signInWithCognito, UNAVAILABLE_MESSAGE } from './cognito'
import { clearSession, loadSession, saveSession, setFlash, type Session } from './session'

export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Please sign in again'

interface AuthValue {
  session: Session | null
  isAdmin: boolean
  signIn: (email: string, password: string) => Promise<Session>
  signOut: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

// The token lives in sessionStorage, so the getter needs no React state: wire it once, before any
// component renders, so the very first request already carries it.
setTokenGetter(() => loadSession()?.token ?? null)

/** Holds the signed-in principal and wires the API client. Must render inside a router. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [session, setSession] = useState<Session | null>(() => loadSession())

  const { pathname, search } = location
  useEffect(
    () =>
      setSessionExpiredHandler(() => {
        clearSession()
        setSession(null)
        // Already signing in: no redirect, and no flash that would linger to a later visit.
        if (pathname === '/signin') return
        setFlash(SESSION_EXPIRED_MESSAGE)
        navigate(`/signin?next=${encodeURIComponent(pathname + search)}`, { replace: true })
      }),
    [navigate, pathname, search],
  )

  // The sign-in mode is fixed per deployment, so one successful answer lasts the page's lifetime.
  const authConfig = useRef<AuthConfigResponse | null>(null)

  const signIn = useCallback(async (email: string, password: string) => {
    authConfig.current ??= await api.get<AuthConfigResponse>('/auth/config').catch(() => {
      throw new Error(UNAVAILABLE_MESSAGE)
    })
    const { mode, region, userPoolClientId } = authConfig.current
    let s: Session
    if (mode === 'cognito') {
      if (!region || !userPoolClientId) throw new Error(UNAVAILABLE_MESSAGE)
      s = await signInWithCognito(region, userPoolClientId, email, password)
    } else {
      const body: LoginRequest = { email, password }
      const res = await api.post<LoginResponse>('/auth/login', body)
      s = { token: res.token, email: res.email, groups: res.groups, expiresAt: res.expiresAt }
    }
    saveSession(s)
    setSession(s)
    return s
  }, [])

  const signOut = useCallback(() => {
    clearSession()
    // The router applies location changes in a transition; drop the principal in the same one so
    // both land in a single render (otherwise RequireAdmin sees no session and redirects to /signin).
    startTransition(() => {
      setSession(null)
      navigate('/', { replace: true })
    })
  }, [navigate])

  const value = useMemo<AuthValue>(
    () => ({ session, isAdmin: !!session?.groups.includes('admin'), signIn, signOut }),
    [session, signIn, signOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
