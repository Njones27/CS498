import { Component, Suspense, type ReactNode } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { AdminLotProvider, useAdminLot } from '../admin/AdminLotContext'
import { LotPicker } from '../admin/LotPicker'
import { useAuth } from '../auth/AuthContext'
import { ThemeToggle } from './ThemeToggle'

interface ChunkErrorBoundaryProps {
  children: ReactNode
}

interface ChunkErrorBoundaryState {
  hasError: boolean
}

export class ChunkErrorBoundary extends Component<ChunkErrorBoundaryProps, ChunkErrorBoundaryState> {
  override state: ChunkErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ChunkErrorBoundaryState {
    return { hasError: true }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <main className="page">
          <p className="notice notice--error" role="alert">
            Failed to load page.{' '}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => window.location.reload()}
            >
              Reload the page
            </button>
          </p>
        </main>
      )
    }
    return this.props.children
  }
}

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
        <div className="topbar__end">
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
          <ThemeToggle />
        </div>
      </header>
      {/* Switching lots in the picker remounts the page, so pages that read the lot once reload. */}
      <ChunkErrorBoundary>
        <Suspense fallback={<main className="page"><p className="muted">Loading…</p></main>}>
          <Outlet key={generation} />
        </Suspense>
      </ChunkErrorBoundary>
    </>
  )
}
