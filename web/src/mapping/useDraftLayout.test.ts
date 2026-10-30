import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { deferred, mockFetch } from '../test/helpers'
import { draftFixture } from './fixtures/kevin'
import type { DraftLayout } from './types'
import { toDraftUpdate, useDraftLayout } from './useDraftLayout'

const URL = '/admin/lots/test-lot/layout/draft'
const STALE = 'This draft changed in another window. Reload to see the latest.'

afterEach(() => {
  vi.unstubAllGlobals()
})

type Reply = { status?: number; body: unknown }

/** The JSON body of the n-th call to the fetch mock. */
function sentBody(fetchMock: ReturnType<typeof mockFetch>, n: number): unknown {
  return JSON.parse(String(fetchMock.mock.calls[n][1]?.body))
}

function saved(draft: DraftLayout): DraftLayout {
  return { ...draft, revision: draft.revision + 1, updatedAt: '2026-10-28T15:00:00Z', updatedBy: 'admin@example.edu' }
}

async function loaded(
  routes: Record<string, Reply | ((init?: RequestInit) => Reply | Promise<Reply>)> = {},
  options?: Parameters<typeof useDraftLayout>[1],
) {
  const fetchMock = mockFetch({ [`GET ${URL}`]: { body: draftFixture() }, ...routes })
  const hook = renderHook(() => useDraftLayout('test-lot', options))
  await waitFor(() => expect(hook.result.current.draft).not.toBeNull())
  return { fetchMock, hook }
}

const renamed = (d: DraftLayout, label: string): DraftLayout => ({
  ...d,
  spaces: d.spaces.map((s) => (s.spaceId === 'A-02' ? { ...s, label } : s)),
})

describe('api.put', () => {
  it('sends a JSON PUT', async () => {
    const fetchMock = mockFetch({ 'PUT /x': { body: { ok: true } } })
    expect(await api.put('/x', { a: 1 })).toEqual({ ok: true })
    const init = fetchMock.mock.calls[0][1]
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBe('{"a":1}')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })
})

describe('toDraftUpdate', () => {
  it('drops the server-owned fields', () => {
    const body = toDraftUpdate(draftFixture({ revision: 4 }))
    expect(Object.keys(body).sort()).toEqual(['revision', 'schematic', 'spaces', 'viewpoints'])
    expect(body.revision).toBe(4)
    expect(body.viewpoints[0]).toEqual({
      viewId: 'V1',
      name: 'North corner',
      outlines: draftFixture().viewpoints[0].outlines,
      outlineReview: { 'A-01': { source: 'drawn', status: 'accepted' } },
    })
  })
})

describe('useDraftLayout', () => {
  it('loads the draft', async () => {
    const { hook } = await loaded()
    const s = hook.result.current
    expect(s.draft).toEqual(draftFixture())
    expect([s.loading, s.dirty, s.stale, s.error]).toEqual([false, false, false, null])
  })

  it('reports a load error', async () => {
    mockFetch({ [`GET ${URL}`]: { status: 404, body: { error: 'not_found', message: 'Lot not found' } } })
    const { result } = renderHook(() => useDraftLayout('test-lot'))
    await waitFor(() => expect(result.current.error).toBe('Lot not found'))
    expect(result.current.draft).toBeNull()
  })

  // US-07 #7: edits go to the server on Save, so a reload or another laptop sees them.
  it('US-07 #7 draft survives a reload: save sends the edited draft with its revision', async () => {
    const edited = renamed(draftFixture(), 'A-2')
    const { fetchMock, hook } = await loaded({ [`PUT ${URL}`]: { body: saved(edited) } })
    act(() => hook.result.current.setDraft(edited))
    expect(hook.result.current.dirty).toBe(true)

    let result: DraftLayout | null = null
    await act(async () => {
      result = await hook.result.current.save()
    })
    expect(sentBody(fetchMock, 1)).toEqual(toDraftUpdate(edited))
    expect(result).toEqual(saved(edited))
    expect(hook.result.current.draft).toEqual(saved(edited))
    expect(hook.result.current.dirty).toBe(false)
  })

  it('US-07 #7 stale revision: a 409 marks the draft stale until reload', async () => {
    let gets = 0
    const { hook } = await loaded({
      [`GET ${URL}`]: () => ({ body: draftFixture({ revision: gets++ === 0 ? 0 : 3 }) }),
      [`PUT ${URL}`]: { status: 409, body: { error: 'stale_revision', message: STALE } },
    })
    act(() => hook.result.current.setDraft(renamed(draftFixture(), 'mine')))
    let result: DraftLayout | null = draftFixture()
    await act(async () => {
      result = await hook.result.current.save()
    })
    expect(result).toBeNull()
    expect(hook.result.current.stale).toBe(true)
    expect(hook.result.current.saveError).toBe(STALE)
    expect(hook.result.current.dirty).toBe(true) // the local edits are not silently dropped

    act(() => hook.result.current.reload())
    await waitFor(() => expect(hook.result.current.draft?.revision).toBe(3))
    expect([hook.result.current.stale, hook.result.current.dirty, hook.result.current.saveError]).toEqual([false, false, null])
  })

  it('keeps other save errors separate from stale', async () => {
    const { hook } = await loaded({
      [`PUT ${URL}`]: { status: 422, body: { error: 'cannot_delete_published_space', message: 'nope' } },
    })
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.result.current.stale).toBe(false)
    expect(hook.result.current.saveError).toBe('nope')
  })

  it('keeps edits made while a save is in flight', async () => {
    const hold = deferred<Reply>()
    const { fetchMock, hook } = await loaded({ [`PUT ${URL}`]: () => hold.promise })
    const first = renamed(draftFixture(), 'first')
    act(() => hook.result.current.setDraft(first))
    let pending!: Promise<DraftLayout | null>
    act(() => {
      pending = hook.result.current.save()
    })
    expect(hook.result.current.saving).toBe(true)
    expect(hook.result.current.save()).toBe(pending) // a second Save joins the first
    const second = renamed(first, 'second')
    act(() => hook.result.current.setDraft(second))

    await act(async () => {
      hold.resolve({ body: saved(first) })
      await pending
    })
    const s = hook.result.current
    expect(s.draft?.spaces[1].label).toBe('second')
    expect(s.draft?.revision).toBe(1) // the next save goes out with the new revision
    expect(s.dirty).toBe(true)
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(1)
  })

  it('a save asked for after an edit made during a save sends that edit once the first lands', async () => {
    const hold = deferred<Reply>()
    let puts = 0
    const { fetchMock, hook } = await loaded({
      [`PUT ${URL}`]: (init) => {
        if (puts++ === 0) return hold.promise
        const body = JSON.parse(String(init?.body)) as DraftLayout
        return { body: saved({ ...draftFixture(), ...body }) }
      },
    })
    const first = renamed(draftFixture(), 'first')
    act(() => hook.result.current.setDraft(first))
    let pending!: Promise<DraftLayout | null>
    act(() => {
      pending = hook.result.current.save()
    })
    const second = renamed(first, 'second') // e.g. an outline committed right after another
    act(() => hook.result.current.setDraft(second))
    let followUp!: Promise<DraftLayout | null>
    act(() => {
      followUp = hook.result.current.save()
    })
    expect(followUp).not.toBe(pending)

    await act(async () => {
      hold.resolve({ body: saved(first) })
      await followUp
    })
    const putBodies = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT').map((c) => JSON.parse(String(c[1]?.body)))
    expect(putBodies.map((b: DraftLayout) => [b.revision, b.spaces[1].label])).toEqual([
      [0, 'first'],
      [1, 'second'],
    ])
    expect(hook.result.current.draft?.revision).toBe(2)
    expect(hook.result.current.dirty).toBe(false)
  })

  it('refreshReferenceImages picks up a new photo and keeps local edits', async () => {
    const uploaded = draftFixture({
      viewpoints: draftFixture().viewpoints.map((v) =>
        v.viewId === 'V2' ? { ...v, referenceImage: { url: '/api/_test/objects/ref-v2.jpg', width: 800, height: 600 } } : v,
      ),
    })
    let gets = 0
    const { hook } = await loaded({ [`GET ${URL}`]: () => ({ body: gets++ === 0 ? draftFixture() : uploaded }) })
    act(() => hook.result.current.setDraft(renamed(draftFixture(), 'local')))
    await act(async () => {
      await hook.result.current.refreshReferenceImages()
    })
    const s = hook.result.current
    expect(s.draft?.viewpoints[1].referenceImage).toEqual({ url: '/api/_test/objects/ref-v2.jpg', width: 800, height: 600 })
    expect(s.draft?.spaces[1].label).toBe('local')
    expect(s.dirty).toBe(true)
  })

  const v2Photo = { url: '/api/_test/objects/ref-v2.jpg', width: 800, height: 600 }
  const withV2Photo = (d: DraftLayout): DraftLayout => ({
    ...d,
    viewpoints: d.viewpoints.map((v) => (v.viewId === 'V2' ? { ...v, referenceImage: v2Photo } : v)),
  })

  it('refreshReferenceImages shows a just-uploaded photo even when the refetch fails', async () => {
    let gets = 0
    const { hook } = await loaded({
      [`GET ${URL}`]: () =>
        gets++ === 0 ? { body: draftFixture() } : { status: 500, body: { error: 'internal', message: 'Server error' } },
    })
    act(() => hook.result.current.setDraft(renamed(draftFixture(), 'local')))
    await act(async () => {
      await hook.result.current.refreshReferenceImages({ lotId: 'test-lot', viewId: 'V2', referenceImage: v2Photo })
    })
    const s = hook.result.current
    expect(s.draft?.viewpoints[1].referenceImage).toEqual(v2Photo)
    expect(s.draft?.spaces[1].label).toBe('local')
    expect(s.saveError).toBe('Server error')
    // Undo keeps the photo: it is stored, not a local edit.
    act(() => hook.result.current.undo())
    expect(hook.result.current.draft?.viewpoints[1].referenceImage).toEqual(v2Photo)
  })

  it("refreshReferenceImages ignores an upload for another lot", async () => {
    const { hook } = await loaded()
    await act(async () => {
      await hook.result.current.refreshReferenceImages({ lotId: 'north', viewId: 'V2', referenceImage: v2Photo })
    })
    expect(hook.result.current.draft?.viewpoints[1].referenceImage).toBeNull()
  })

  it('a save that lands after a photo refresh keeps the refreshed photo', async () => {
    const hold = deferred<Reply>()
    let gets = 0
    const { hook } = await loaded({
      [`GET ${URL}`]: () => ({ body: gets++ === 0 ? draftFixture() : withV2Photo(draftFixture()) }),
      [`PUT ${URL}`]: () => hold.promise,
    })
    const first = renamed(draftFixture(), 'first') // e.g. an outline finished while the photo uploads
    act(() => hook.result.current.setDraft(first))
    let pending!: Promise<DraftLayout | null>
    act(() => {
      pending = hook.result.current.save()
    })
    await act(async () => {
      await hook.result.current.refreshReferenceImages()
    })
    expect(hook.result.current.draft?.viewpoints[1].referenceImage).toEqual(v2Photo)

    await act(async () => {
      hold.resolve({ body: saved(first) }) // the PUT was answered before the photo was stored
      await pending
    })
    const s = hook.result.current
    expect(s.draft?.viewpoints[1].referenceImage).toEqual(v2Photo)
    expect(s.draft?.revision).toBe(1)
    expect(s.dirty).toBe(false)
  })

  it('a save with no photo refresh during it takes the server response whole', async () => {
    const { hook } = await loaded({ [`PUT ${URL}`]: () => ({ body: withV2Photo(saved(draftFixture())) }) })
    act(() => hook.result.current.setDraft(renamed(draftFixture(), 'x')))
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.result.current.draft?.viewpoints[1].referenceImage).toEqual(v2Photo)
  })

  it("never returns the previous lot's draft while another loads", async () => {
    const other = deferred<Reply>()
    mockFetch({
      [`GET ${URL}`]: { body: draftFixture() },
      'GET /admin/lots/north/layout/draft': () => other.promise,
    })
    const { result, rerender } = renderHook(({ lot }) => useDraftLayout(lot), { initialProps: { lot: 'test-lot' } })
    await waitFor(() => expect(result.current.draft).not.toBeNull())
    rerender({ lot: 'north' })
    expect(result.current.draft).toBeNull()
    await act(async () => other.resolve({ body: draftFixture({ lotId: 'north' }) }))
    expect(result.current.draft?.lotId).toBe('north')
  })

  describe('undo and redo', () => {
    it('supports undoing and redoing local changes', async () => {
      const { hook } = await loaded()
      expect(hook.result.current.canUndo).toBe(false)
      expect(hook.result.current.canRedo).toBe(false)

      const first = renamed(draftFixture(), 'Step 1')
      act(() => hook.result.current.setDraft(first))
      expect(hook.result.current.draft?.spaces[1].label).toBe('Step 1')
      expect(hook.result.current.canUndo).toBe(true)
      expect(hook.result.current.canRedo).toBe(false)

      const second = renamed(first, 'Step 2')
      act(() => hook.result.current.setDraft(second))
      expect(hook.result.current.draft?.spaces[1].label).toBe('Step 2')
      expect(hook.result.current.canUndo).toBe(true)
      expect(hook.result.current.canRedo).toBe(false)

      // Undo to Step 1
      act(() => hook.result.current.undo())
      expect(hook.result.current.draft?.spaces[1].label).toBe('Step 1')
      expect(hook.result.current.canUndo).toBe(true)
      expect(hook.result.current.canRedo).toBe(true)

      // Undo to initial
      act(() => hook.result.current.undo())
      expect(hook.result.current.draft?.spaces[1].label).toBe(draftFixture().spaces[1].label)
      expect(hook.result.current.canUndo).toBe(false)
      expect(hook.result.current.canRedo).toBe(true)

      // Redo to Step 1
      act(() => hook.result.current.redo())
      expect(hook.result.current.draft?.spaces[1].label).toBe('Step 1')
      expect(hook.result.current.canUndo).toBe(true)
      expect(hook.result.current.canRedo).toBe(true)

      // A new edit clears redo future
      const third = renamed(hook.result.current.draft!, 'Step 3')
      act(() => hook.result.current.setDraft(third))
      expect(hook.result.current.canUndo).toBe(true)
      expect(hook.result.current.canRedo).toBe(false)
    })

    it('keeps the last 50 states', async () => {
      const { hook } = await loaded()
      let draft = draftFixture()
      for (let i = 1; i <= 55; i++) {
        draft = renamed(draft, `Step ${i}`)
        const next = draft
        act(() => hook.result.current.setDraft(next))
      }
      let undos = 0
      while (hook.result.current.canUndo) {
        act(() => hook.result.current.undo())
        undos++
      }
      expect(undos).toBe(50)
      expect(hook.result.current.draft?.spaces[1].label).toBe('Step 5') // older states were dropped
    })

    it('keeps server revision valid when undoing after a save', async () => {
      const first = renamed(draftFixture(), 'Edit 1')
      const { fetchMock, hook } = await loaded({
        [`PUT ${URL}`]: (init) => {
          const body = JSON.parse(String(init?.body)) as DraftLayout
          return { body: saved({ ...body, lotId: 'test-lot', basedOnVersion: 1 }) }
        },
      })
      act(() => hook.result.current.setDraft(first))

      // Save sends revision 0 -> returns revision 1
      await act(async () => {
        await hook.result.current.save()
      })
      expect(sentBody(fetchMock, 1)).toMatchObject({ revision: 0 })
      expect(hook.result.current.draft?.revision).toBe(1)
      expect(hook.result.current.dirty).toBe(false)

      // Now undo back to original layout
      act(() => hook.result.current.undo())
      expect(hook.result.current.draft?.spaces[1].label).toBe(draftFixture().spaces[1].label)
      expect(hook.result.current.draft?.revision).toBe(1) // preserved revision 1!
      expect(hook.result.current.dirty).toBe(true)

      // Re-saving sends revision 1 (not stale revision 0)
      await act(async () => {
        await hook.result.current.save()
      })
      expect(sentBody(fetchMock, 2)).toMatchObject({ revision: 1 })
      expect(hook.result.current.draft?.revision).toBe(2)
      expect(hook.result.current.dirty).toBe(false)
    })
  })

  describe('autosave', () => {
    it('debounces and automatically saves edits when enabled', async () => {
      const first = renamed(draftFixture(), 'Autosaved')
      const { fetchMock, hook } = await loaded(
        {
          [`PUT ${URL}`]: (init) => {
            const body = JSON.parse(String(init?.body)) as DraftLayout
            return { body: saved({ ...body, lotId: 'test-lot', basedOnVersion: 1 }) }
          },
        },
        { autosave: true, debounceMs: 50 },
      )

      act(() => hook.result.current.setDraft(first))
      expect(hook.result.current.dirty).toBe(true)
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(0)

      // Within 50ms, autosave fires
      await waitFor(() => expect(hook.result.current.dirty).toBe(false))
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(1)
      expect(hook.result.current.draft?.revision).toBe(1)
    })

    it('does not save automatically when autosave is disabled', async () => {
      const first = renamed(draftFixture(), 'Manual Only')
      const { fetchMock, hook } = await loaded(
        { [`PUT ${URL}`]: { body: saved(first) } },
        { autosave: false, debounceMs: 50 },
      )

      act(() => hook.result.current.setDraft(first))
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(0)
      expect(hook.result.current.dirty).toBe(true)
    })
  })
})
