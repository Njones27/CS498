import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../api/client'

export interface FetchState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** Load data with an async function; re-runs (from empty) when `key` changes, or on reload(). */
export function useFetch<T>(load: () => Promise<T>, key: string): FetchState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const [loadedKey, setLoadedKey] = useState(key)

  // A new key means a different resource: drop the previous one's data during render so no
  // frame ever pairs it with the new key. reload() keeps the current data while refetching.
  if (loadedKey !== key) {
    setLoadedKey(key)
    setData(null)
    setError(null)
    setLoading(true)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load()
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `load` is intentionally keyed by `key` so callers can pass inline closures.
  }, [key, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload }
}
