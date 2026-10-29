/** Base URL for API calls. Dev: the Vite proxy at /api. Phase 2: VITE_API_BASE. */
export const API_BASE: string =
  import.meta.env.VITE_API_BASE ?? `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`
