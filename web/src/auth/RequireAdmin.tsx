import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'

/** Gate for /admin routes: sign-in redirect with `next`, or a no-access message. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, isAdmin } = useAuth()
  const location = useLocation()

  if (!session) {
    const next = location.pathname + location.search + location.hash
    return <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />
  }
  if (!isAdmin) {
    return (
      <main className="page">
        <p className="notice notice--error" role="alert">
          You do not have admin access
        </p>
      </main>
    )
  }
  return <>{children}</>
}
