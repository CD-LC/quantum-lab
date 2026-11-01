import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * resolveSubject: a presented-but-unacceptable token is a 401/503, never a
 * silently minted guest (audit finding exams-certs #37); the guest cookie is
 * Secure on https; a malformed cookie never throws.
 */

type GetUser = (token: string) => Promise<{ data: { user: unknown }; error: unknown }>
const auth: { getUser: GetUser } = { getUser: async () => ({ data: { user: null }, error: null }) }

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => ({ auth: { getUser: (t: string) => auth.getUser(t) } }),
}))

const { resolveSubject } = await import('@/lib/exams/session')

const GUEST = `guest_${'ab12'.repeat(8)}`

function req(headers: Record<string, string> = {}, url = 'https://qubit16.test/api/exams/x/attempt') {
  return new Request(url, { headers })
}

beforeEach(() => {
  auth.getUser = async () => ({ data: { user: null }, error: null })
})

describe('resolveSubject', () => {
  it('resolves a verified token to the user, with no guest cookie', async () => {
    auth.getUser = async () => ({ data: { user: { id: 'u1', email: 'a@b.test' } }, error: null })
    const r = await resolveSubject(req({ authorization: 'Bearer good' }))
    expect(r.subject).toEqual({ kind: 'user', id: 'u1' })
    expect(r.setCookie).toBeUndefined()
    expect(r.denied).toBeUndefined()
  })

  it('answers 401 for a token the auth service rejects', async () => {
    auth.getUser = async () => ({ data: { user: null }, error: { message: 'jwt expired', status: 401 } })
    const r = await resolveSubject(req({ authorization: 'Bearer stale' }))
    expect(r.denied?.status).toBe(401)
    const body = await r.denied!.json()
    expect(body.code).toBe('unauthorized')
  })

  it('answers 503 with Retry-After when the auth service is unreachable', async () => {
    auth.getUser = async () => {
      throw new Error('fetch failed')
    }
    const r = await resolveSubject(req({ authorization: 'Bearer maybe-good' }))
    expect(r.denied?.status).toBe(503)
    expect(r.denied?.headers.get('retry-after')).toBe('5')
  })

  it('also denies a presented bad token when a valid guest cookie rides along', async () => {
    auth.getUser = async () => ({ data: { user: null }, error: { message: 'bad', status: 401 } })
    const r = await resolveSubject(req({ authorization: 'Bearer stale', cookie: `ql_exam_guest=${GUEST}` }))
    expect(r.denied?.status).toBe(401)
  })

  it('does not deny an anonymous request: no token means guest mode', async () => {
    const r = await resolveSubject(req())
    expect(r.denied).toBeUndefined()
    expect(r.subject.kind).toBe('guest')
    expect(r.setCookie).toMatch(/^ql_exam_guest=guest_[0-9a-f]{32};/)
  })

  it('reuses a well-formed guest cookie without setting another', async () => {
    const r = await resolveSubject(req({ cookie: `a=b; ql_exam_guest=${GUEST}` }))
    expect(r.subject).toEqual({ kind: 'guest', id: GUEST })
    expect(r.setCookie).toBeUndefined()
  })
})

describe('the guest cookie', () => {
  it('is Secure over https', async () => {
    const r = await resolveSubject(req())
    expect(r.setCookie).toContain('; Secure')
    expect(r.setCookie).toContain('HttpOnly')
    expect(r.setCookie).toContain('SameSite=Lax')
  })

  it('is Secure behind a proxy that terminates TLS', async () => {
    const r = await resolveSubject(req({ 'x-forwarded-proto': 'https' }, 'http://internal:3000/x'))
    expect(r.setCookie).toContain('; Secure')
  })

  it('is not Secure on plain http://localhost, where the browser would drop it', async () => {
    const r = await resolveSubject(req({}, 'http://localhost:3000/x'))
    expect(r.setCookie).not.toContain('Secure')
  })

  it.each(['%', '%E0%A4%A', '%zz', 'guest_%'])('treats malformed cookie %j as absent instead of throwing', async (bad) => {
    const r = await resolveSubject(req({ cookie: `ql_exam_guest=${bad}` }))
    expect(r.subject.kind).toBe('guest')
    expect(r.setCookie).toBeDefined()
    expect(r.denied).toBeUndefined()
  })

  it('skips a malformed duplicate and uses the later valid one', async () => {
    const r = await resolveSubject(req({ cookie: `ql_exam_guest=%E0%A4%A; ql_exam_guest=${GUEST}` }))
    expect(r.subject).toEqual({ kind: 'guest', id: GUEST })
  })
})
