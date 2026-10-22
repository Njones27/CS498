import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, configureClient } from '../api/client'
import type { LoginRequest, LoginResponse } from '../api/schemas'
import { clearSession, loadSession, saveSession, setFlash, type Session } from './session'

export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Please sign in again'

interface AuthValue {
  session: Session | null
  isAdmin: boolean
  signIn: (email: string, password: string) => Promise<Session>
  signOut: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

/** Holds the signed-in principal and wires the API client. Must render inside a router. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [session, setSession] = useState<Session | null>(() => loadSession())

  // Configured during render so the very first request already sees the token.
  configureClient({
    getToken: () => loadSession()?.token ?? null,
    onSessionExpired: () => {
      clearSession()
      setFlash(SESSION_EXPIRED_MESSAGE)
      setSession(null)
      const next = location.pathname + location.search
      navigate(`/signin?next=${encodeURIComponent(next)}`, { replace: true })
    },
  })

  const signIn = useCallback(async (email: string, password: string) => {
    const body: LoginRequest = { email, password }
    const res = await api.post<LoginResponse>('/auth/login', body)
    const s: Session = {
      token: res.token,
      email: res.email,
      groups: res.groups,
      expiresAt: res.expiresAt,
    }
    saveSession(s)
    setSession(s)
    return s
  }, [])

  const signOut = useCallback(() => {
    clearSession()
    // Leave the guarded page before dropping the principal, or RequireAdmin redirects to /signin.
    void Promise.resolve(navigate('/', { replace: true })).then(() => setSession(null))
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
