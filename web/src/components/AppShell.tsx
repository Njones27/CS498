import { Link, Outlet } from 'react-router-dom'
import { AdminLotProvider, useAdminLot } from '../admin/AdminLotContext'
import { LotPicker } from '../admin/LotPicker'
import { useAuth } from '../auth/AuthContext'

export function AppShell() {
  return (
    <AdminLotProvider>
      <Shell />
    </AdminLotProvider>
  )
}

function Shell() {
  const { session, isAdmin, signOut } = useAuth()
  const { generation } = useAdminLot()
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          Parking Availability
        </Link>
        {session && (
          <nav className="topbar__nav" aria-label="Account">
            {isAdmin && <LotPicker />}
            <Link to="/admin">Admin</Link>
            <span className="topbar__email">{session.email}</span>
            <button type="button" className="button button--ghost" onClick={signOut}>
              Sign out
            </button>
          </nav>
        )}
      </header>
      {/* Switching lots in the picker remounts the page, so pages that read the lot once reload. */}
      <Outlet key={generation} />
    </>
  )
}
