import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeIdToken } from '../test/helpers'
import { sessionFromIdToken, signInWithCognito, UNAVAILABLE_MESSAGE } from './cognito'

describe('sessionFromIdToken', () => {
  it('reads email, groups and exp from the payload', () => {
    const token = fakeIdToken({ email: 'admin@example.edu', 'cognito:groups': ['admin'], exp: 4102444800 })
    expect(sessionFromIdToken(token)).toEqual({
      token,
      email: 'admin@example.edu',
      groups: ['admin'],
      expiresAt: '2100-01-01T00:00:00.000Z',
    })
  })

  it('decodes a non-ASCII email as UTF-8', () => {
    const email = 'jürgen.müller+café@exämple.edu'
    expect(sessionFromIdToken(fakeIdToken({ email, exp: 4102444800 }))?.email).toBe(email)
  })

  it('defaults groups to [] and drops non-string entries', () => {
    expect(sessionFromIdToken(fakeIdToken({ email: 'a@b.c', exp: 1 }))?.groups).toEqual([])
    expect(
      sessionFromIdToken(fakeIdToken({ email: 'a@b.c', exp: 1, 'cognito:groups': ['admin', 7] }))?.groups,
    ).toEqual(['admin'])
    expect(
      sessionFromIdToken(fakeIdToken({ email: 'a@b.c', exp: 1, 'cognito:groups': 'admin' }))?.groups,
    ).toEqual([])
  })

  it.each([
    ['no email', { exp: 4102444800 }],
    ['an empty email', { email: '', exp: 4102444800 }],
    ['no exp', { email: 'a@b.c' }],
    ['a string exp', { email: 'a@b.c', exp: '4102444800' }],
  ])('rejects a payload with %s', (_, claims) => {
    expect(sessionFromIdToken(fakeIdToken(claims))).toBeNull()
  })

  it.each([
    ['a token with no payload', 'header'],
    ['a payload that is not base64', 'h.!!!.s'],
    ['a payload that is not JSON', `h.${btoa('not json')}.s`],
    ['a payload that is not an object', `h.${btoa('42')}.s`],
    ['a payload that is not valid UTF-8', `h.${btoa('\xff\xfe')}.s`],
  ])('rejects %s', (_, token) => {
    expect(sessionFromIdToken(token)).toBeNull()
  })
})

describe('signInWithCognito', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('never builds a hostname from something that is not a region name', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const region of ['evil.example/x#', 'us-east-1.evil.example', '', 'US-EAST-1']) {
      await expect(signInWithCognito(region, 'client', 'a@b.c', 'pw')).rejects.toThrow(UNAVAILABLE_MESSAGE)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
