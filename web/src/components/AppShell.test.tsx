import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../auth/AuthContext'
import { AppShell, ChunkErrorBoundary } from './AppShell'

function ThrowingComponent(): never {
  throw new Error('Failed to fetch dynamically imported module: /assets/SomePage.js')
}

describe('ChunkErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <ChunkErrorBoundary>
        <div>Page content</div>
      </ChunkErrorBoundary>,
    )
    expect(screen.getByText('Page content')).toBeInTheDocument()
  })

  it('renders fallback notice with reload button when a chunk fails to load', async () => {
    const user = userEvent.setup()
    const reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { reload: reloadSpy },
    })

    // Suppress console.error from React boundary error logging
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <ChunkErrorBoundary>
        <ThrowingComponent />
      </ChunkErrorBoundary>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/failed to load page|something went wrong/i)
    const button = screen.getByRole('button', { name: /reload the page/i })
    expect(button).toBeInTheDocument()

    await user.click(button)
    expect(reloadSpy).toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('resets the error boundary when navigating to a new route', async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <MemoryRouter initialEntries={['/bad']}>
        <AuthProvider>
          <div>
            <Link to="/good">Go to Good</Link>
            <Routes>
              <Route path="/" element={<AppShell />}>
                <Route path="bad" element={<ThrowingComponent />} />
                <Route path="good" element={<div>Good Page</div>} />
              </Route>
            </Routes>
          </div>
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Go to Good' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Good Page')).toBeInTheDocument()

    consoleError.mockRestore()
  })
})
