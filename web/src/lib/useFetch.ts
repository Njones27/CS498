import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../api/client'

export interface FetchState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** Load data with an async function; re-runs when `key` changes or on reload(). */
export function useFetch<T>(load: () => Promise<T>, key: string): FetchState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

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
