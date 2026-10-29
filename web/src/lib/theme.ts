/** Colour theme: Auto follows the OS (prefers-color-scheme); Light and Dark override it. */
export type ThemeMode = 'auto' | 'light' | 'dark'

export const THEME_KEY = 'parking.theme'
export const THEME_MODES: readonly ThemeMode[] = ['auto', 'light', 'dark']

const isMode = (v: unknown): v is ThemeMode => THEME_MODES.includes(v as ThemeMode)

export function readStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return isMode(v) ? v : 'auto'
  } catch {
    return 'auto'
  }
}

export function storeTheme(mode: ThemeMode) {
  try {
    if (mode === 'auto') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, mode)
  } catch {
    // storage unavailable; the theme applies for this visit only
  }
}

/** index.css keys the dark tokens off data-theme on <html>; no attribute means Auto. */
export function applyTheme(mode: ThemeMode, root: HTMLElement = document.documentElement) {
  if (mode === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}
