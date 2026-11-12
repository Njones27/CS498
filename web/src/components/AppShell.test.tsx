import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../auth/AuthContext'
import { AppShell, ChunkErrorBoundary } from './AppShell'
import { Main } from './Main'

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

  it('renders fallback inside #main-content with tabIndex -1 on chunk error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ChunkErrorBoundary>
        <ThrowingComponent />
      </ChunkErrorBoundary>,
    )
    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'main-content')
    expect(main).toHaveAttribute('tabindex', '-1')
    consoleError.mockRestore()
  })
})

describe('AppShell skip link and Main', () => {
  it('skip link targets #main-content', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<Main><h1>Content</h1></Main>} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
    const skipLink = screen.getByRole('link', { name: 'Skip to main content' })
    expect(skipLink).toBeInTheDocument()
    expect(skipLink).toHaveAttribute('href', '#main-content')
    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'main-content')
    expect(main).toHaveAttribute('tabindex', '-1')
  })

  it('Main component defaults to className="page" and sets accessibility attributes', () => {
    const { unmount } = render(<Main><p>Hello</p></Main>)
    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'main-content')
    expect(main).toHaveAttribute('tabindex', '-1')
    expect(main).toHaveClass('page')
    unmount()

    render(<Main className="page page--narrow" data-testid="custom"><p>Narrow</p></Main>)
    const custom = screen.getByTestId('custom')
    expect(custom).toHaveClass('page', 'page--narrow')
    expect(custom).toHaveAttribute('id', 'main-content')
    expect(custom).toHaveAttribute('tabindex', '-1')
  })
})
