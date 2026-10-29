import { useState, type ChangeEvent } from 'react'
import { THEME_MODES, applyTheme, readStoredTheme, storeTheme, type ThemeMode } from '../lib/theme'

const LABELS: Record<ThemeMode, string> = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }

/** Header theme picker. main.tsx applies the stored theme before the first render. */
export function ThemeToggle() {
  const [mode, setMode] = useState(readStoredTheme)

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as ThemeMode
    setMode(next)
    storeTheme(next)
    applyTheme(next)
  }

  return (
    <span className="theme-toggle">
      <select value={mode} onChange={onChange} aria-label="Theme">
        {THEME_MODES.map((m) => (
          <option key={m} value={m}>
            {LABELS[m]}
          </option>
        ))}
      </select>
    </span>
  )
}
