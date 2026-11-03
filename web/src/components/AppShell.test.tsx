import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChunkErrorBoundary } from './AppShell'

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

    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load page\./)
    const button = screen.getByRole('button', { name: /reload the page/i })
    expect(button).toBeInTheDocument()

    await user.click(button)
    expect(reloadSpy).toHaveBeenCalled()

    consoleError.mockRestore()
  })
})
