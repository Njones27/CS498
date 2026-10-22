import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deferred } from '../test/helpers'
import { useFetch } from './useFetch'

describe('useFetch', () => {
  it("drops the previous key's data as soon as the key changes", async () => {
    const a = deferred<string>()
    const b = deferred<string>()
    const loaders: Record<string, Promise<string>> = { a: a.promise, b: b.promise }
    const { result, rerender } = renderHook(({ k }) => useFetch(() => loaders[k], k), { initialProps: { k: 'a' } })

    await act(async () => a.resolve('lot A'))
    expect(result.current.data).toBe('lot A')

    rerender({ k: 'b' })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(true)

    await act(async () => b.resolve('lot B'))
    expect(result.current.data).toBe('lot B')
  })

  it('keeps the current data while reloading the same key', async () => {
    let n = 0
    const { result } = renderHook(() => useFetch(() => Promise.resolve(++n), 'k'))
    await act(async () => {})
    expect(result.current.data).toBe(1)
    act(() => result.current.reload())
    expect(result.current.data).toBe(1)
    await act(async () => {})
    expect(result.current.data).toBe(2)
  })
})
