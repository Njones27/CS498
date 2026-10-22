import { API_BASE } from './base'
import type { ErrorResponse } from './schemas'

/** An API failure carrying the HDD §6.3 `{error, message}` envelope plus any extra fields. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: Partial<ErrorResponse>

  constructor(status: number, body: Partial<ErrorResponse>) {
    super(body.message ?? `Request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.code = body.error ?? 'unknown'
    this.body = body
  }

  get originalImageId(): string | null | undefined {
    return this.body.originalImageId
  }

  get uploadedAt(): string | null | undefined {
    return this.body.uploadedAt
  }
}

type TokenGetter = () => string | null
type ExpiredHandler = () => void

const NOOP: ExpiredHandler = () => {}
let getToken: TokenGetter = () => null
let onSessionExpired: ExpiredHandler = NOOP

/** Where the client reads the bearer token from. Wired once, at module load, by the auth module. */
export function setTokenGetter(fn: TokenGetter): void {
  getToken = fn
}

/**
 * Called when a request fails with 401 `session_expired`, but only while the token that request
 * was sent with is still the current one (a late 401 must not clobber a newer session).
 * Returns an unsubscribe that restores the no-op handler if `fn` is still installed.
 */
export function setSessionExpiredHandler(fn: ExpiredHandler): () => void {
  onSessionExpired = fn
  return () => {
    if (onSessionExpired === fn) onSessionExpired = NOOP
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Partial<ErrorResponse> = {}
  try {
    const json: unknown = await res.json()
    if (json && typeof json === 'object') body = json as Partial<ErrorResponse>
  } catch {
    body = { message: res.statusText || undefined }
  }
  return new ApiError(res.status, body)
}

/** Typed JSON request against API_BASE. Throws ApiError on non-2xx responses. */
export async function apiRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

  if (!res.ok) {
    const err = await parseError(res)
    if (err.status === 401 && err.code === 'session_expired' && token && getToken() === token) onSessionExpired()
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => apiRequest<T>(path),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return 'Something went wrong'
}
