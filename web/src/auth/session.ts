import type { LoginResponse } from '../api/schemas'

/** The signed-in principal, persisted in sessionStorage for this tab only. */
export type Session = Pick<LoginResponse, 'token' | 'email' | 'groups' | 'expiresAt'>

const KEY = 'parking.session'

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Session
    if (!s.token || !Array.isArray(s.groups)) return null
    return s
  } catch {
    return null
  }
}

export function saveSession(s: Session): void {
  sessionStorage.setItem(KEY, JSON.stringify(s))
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY)
}

const FLASH_KEY = 'parking.flash'

/** One-shot message shown on the next sign-in page render (e.g. session expired). */
export function setFlash(message: string): void {
  sessionStorage.setItem(FLASH_KEY, message)
}

export function peekFlash(): string | null {
  return sessionStorage.getItem(FLASH_KEY)
}

export function clearFlash(): void {
  sessionStorage.removeItem(FLASH_KEY)
}
