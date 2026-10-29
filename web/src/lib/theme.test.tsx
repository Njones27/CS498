import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeToggle } from '../components/ThemeToggle'
import { THEME_KEY, applyTheme, readStoredTheme, storeTheme } from './theme'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('theme storage', () => {
  it('defaults to auto when nothing is stored', () => {
    expect(readStoredTheme()).toBe('auto')
  })

  it('remembers light and dark', () => {
    storeTheme('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(readStoredTheme()).toBe('dark')
    storeTheme('light')
    expect(readStoredTheme()).toBe('light')
  })

  it('choosing auto clears the stored override', () => {
    storeTheme('dark')
    storeTheme('auto')
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(readStoredTheme()).toBe('auto')
  })

  it('ignores unknown stored values', () => {
    localStorage.setItem(THEME_KEY, 'sepia')
    expect(readStoredTheme()).toBe('auto')
  })

  it('falls back to auto when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => storeTheme('dark')).not.toThrow()
    expect(readStoredTheme()).toBe('auto')
  })
})

describe('applyTheme', () => {
  it('sets data-theme for an override and removes it for auto', () => {
    const root = document.documentElement
    applyTheme('dark')
    expect(root).toHaveAttribute('data-theme', 'dark')
    applyTheme('light')
    expect(root).toHaveAttribute('data-theme', 'light')
    applyTheme('auto')
    expect(root).not.toHaveAttribute('data-theme')
  })
})

describe('ThemeToggle', () => {
  it('starts from the stored theme', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    render(<ThemeToggle />)
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark')
  })

  it('applies and remembers a choice, and Auto forgets it', async () => {
    render(<ThemeToggle />)
    const select = screen.getByRole('combobox', { name: 'Theme' })
    expect(select).toHaveValue('auto')
    await userEvent.selectOptions(select, 'light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    await userEvent.selectOptions(select, 'auto')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
  })
})
