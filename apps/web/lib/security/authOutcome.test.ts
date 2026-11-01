import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * verifyCallerOutcome tells "no token", "bad token" and "auth service down"
 * apart (audit finding exams-certs #37). verifiedCaller keeps its old contract:
 * ok → caller, everything else → null.
 */

type GetUser = (token: string) => Promise<{ data: { user: unknown }; error: unknown }>
const state: { getUser: GetUser; client: boolean } = {
  getUser: async () => ({ data: { user: null }, error: null }),
  client: true,
}

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => (state.client ? { auth: { getUser: (t: string) => state.getUser(t) } } : null),
}))

const { verifiedCaller, verifiedCallerId, verifyCallerOutcome } = await import('@/lib/security/auth')

const withToken = (token?: string) =>
  new Request('https://qubit16.test/x', token ? { headers: { authorization: `Bearer ${token}` } } : {})

beforeEach(() => {
  state.client = true
  state.getUser = async () => ({ data: { user: null }, error: null })
})

describe('verifyCallerOutcome', () => {
  it('is none when no token is presented', async () => {
    expect(await verifyCallerOutcome(withToken())).toEqual({ kind: 'none' })
  })

  it('is none when the deployment has no auth client to ask', async () => {
    state.client = false
    expect(await verifyCallerOutcome(withToken('t'))).toEqual({ kind: 'none' })
  })

  it('is ok with a lower-cased email for a good token', async () => {
    state.getUser = async () => ({ data: { user: { id: 'u1', email: ' Ada@Example.TEST ' } }, error: null })
    expect(await verifyCallerOutcome(withToken('t'))).toEqual({
      kind: 'ok',
      caller: { id: 'u1', email: 'ada@example.test' },
    })
  })

  it.each([
    ['a 401 from the auth service', { message: 'bad jwt', status: 401 }],
    ['a 403 session_not_found', { message: 'gone', status: 403 }],
    ['an error with no status', { message: 'bad jwt' }],
  ])('is invalid for %s', async (_label, error) => {
    state.getUser = async () => ({ data: { user: null }, error })
    expect(await verifyCallerOutcome(withToken('t'))).toEqual({ kind: 'invalid' })
  })

  it('is invalid when the service answers with no user and no error', async () => {
    expect(await verifyCallerOutcome(withToken('t'))).toEqual({ kind: 'invalid' })
  })

  it.each([
    ['a 500', { message: 'boom', status: 500 }],
    ['a 503', { message: 'down', status: 503 }],
    ['a 429', { message: 'slow down', status: 429 }],
    ['a network failure', { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 }],
    ['a retryable error with no status', { name: 'AuthRetryableFetchError', message: 'fetch failed' }],
  ])('is unavailable for %s', async (_label, error) => {
    state.getUser = async () => ({ data: { user: null }, error })
    expect(await verifyCallerOutcome(withToken('t'))).toEqual({ kind: 'unavailable' })
  })

  it('is unavailable when the call throws', async () => {
    state.getUser = async () => {
      throw new Error('socket hang up')
    }
    expect(await verifyCallerOutcome(withToken('t'))).toEqual({ kind: 'unavailable' })
  })
})

describe('verifiedCaller keeps its old contract', () => {
  it('returns null for none, invalid and unavailable alike, and never throws', async () => {
    expect(await verifiedCaller(withToken())).toBeNull()
    state.getUser = async () => ({ data: { user: null }, error: { message: 'bad', status: 401 } })
    expect(await verifiedCaller(withToken('t'))).toBeNull()
    state.getUser = async () => {
      throw new Error('down')
    }
    expect(await verifiedCaller(withToken('t'))).toBeNull()
    expect(await verifiedCallerId(withToken('t'))).toBeNull()
  })

  it('returns the caller for a good token', async () => {
    state.getUser = async () => ({ data: { user: { id: 'u1', email: 'a@b.test' } }, error: null })
    expect(await verifiedCaller(withToken('t'))).toEqual({ id: 'u1', email: 'a@b.test' })
    expect(await verifiedCallerId(withToken('t'))).toBe('u1')
  })
})
