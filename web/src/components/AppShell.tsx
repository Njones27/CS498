import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function AppShell() {
  const { session, signOut } = useAuth()
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          Parking Availability
        </Link>
        {session && (
          <nav className="topbar__nav" aria-label="Account">
            <Link to="/admin">Admin</Link>
            <span className="topbar__email">{session.email}</span>
            <button type="button" className="button button--ghost" onClick={signOut}>
              Sign out
            </button>
          </nav>
        )}
      </header>
      <Outlet />
    </>
  )
}
