/**
 * GET /api/hardware/devices — BYOK-aware availability.
 *
 * Faked: the upstream call, caller verification and the credential listing.
 * Real: the route's own decisions about when to rewrite the listing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  upstream: [] as unknown[],
  upstreamStatus: 200,
  caller: null as { id: string } | null,
  records: [] as Array<{ provider: string; readable: boolean }>,
  storeDown: false,
}))

vi.mock('@/lib/hardware/proxy', () => ({
  READ_LIMIT: { limit: 100, windowMs: 60_000 },
  async limitOrNull() {
    return null
  },
  async forward() {
    return new Response(JSON.stringify(fake.upstream), {
      status: fake.upstreamStatus,
      headers: { 'content-type': 'application/json' },
    })
  },
}))
vi.mock('@/lib/security/auth', () => ({
  bearerToken: (req: Request) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''),
  async verifiedApiCaller() {
    return fake.caller
  },
}))
vi.mock('@/lib/security/providerCredentials', () => ({
  isByokProvider: (v: unknown) => v === 'ibm' || v === 'braket' || v === 'azure',
  async listProviderCredentials() {
    if (fake.storeDown) throw new Error('store down')
    return fake.records
  },
}))

const { GET } = await import('@/app/api/hardware/devices/route')

const devices = () => [
  { id: 'ibm_brisbane', provider: 'ibm', available: false, reason: 'needs token', source: 'catalogue' },
  { id: 'ionq_aria', provider: 'ionq', available: false, reason: 'needs aws', source: 'catalogue' },
]

function request(token?: string): Request {
  return new Request('http://localhost/api/hardware/devices', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

beforeEach(() => {
  fake.upstream = devices()
  fake.upstreamStatus = 200
  fake.caller = { id: 'user-1' }
  fake.records = [{ provider: 'ibm', readable: true }]
  fake.storeDown = false
})

describe('GET /api/hardware/devices', () => {
  it('returns the operator view untouched for an anonymous caller', async () => {
    const body = await (await GET(request())).json()
    expect(body).toEqual(devices())
  })

  it('marks a device available when the signed-in caller stored a credential for its vendor', async () => {
    const body = await (await GET(request('tok'))).json()
    expect(body[0]).toMatchObject({ id: 'ibm_brisbane', available: true, reason: null, byok: true })
    expect(body[1]).toMatchObject({ id: 'ionq_aria', available: false })
  })

  it('ignores an unreadable stored credential', async () => {
    fake.records = [{ provider: 'ibm', readable: false }]
    const body = await (await GET(request('tok'))).json()
    expect(body).toEqual(devices())
  })

  it('degrades to the operator view when the token is invalid or the store is down', async () => {
    fake.caller = null
    expect(await (await GET(request('bad'))).json()).toEqual(devices())
    fake.caller = { id: 'user-1' }
    fake.storeDown = true
    expect(await (await GET(request('tok'))).json()).toEqual(devices())
  })

  it('passes an upstream error through unchanged', async () => {
    fake.upstreamStatus = 503
    const res = await GET(request('tok'))
    expect(res.status).toBe(503)
  })
})
