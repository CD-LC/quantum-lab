/**
 * healthTrust.test.ts — an anonymous caller of GET /api/health learns nothing
 * about the deployment beyond statuses: no detail strings, no release, no
 * environment, on the success path AND on the failure path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rateLimit'

const TOKEN = 'monitor-token-123'

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://app.test/api/health', {
    headers: { 'x-forwarded-for': '203.0.113.77', ...headers },
  })
}

beforeEach(() => {
  __resetRateLimitForTests()
  process.env.HEALTH_DEEP_TOKEN = TOKEN
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.doUnmock('@/lib/observability/health')
  delete process.env.HEALTH_DEEP_TOKEN
  __resetRateLimitForTests()
})

describe('/api/health disclosure', () => {
  it('gives an anonymous caller empty detail, version and environment', async () => {
    const { GET } = await import('@/app/api/health/route')
    const body = (await (await GET(request())).json()) as {
      version: string
      environment: string
      checks: Record<string, { detail: string }>
    }
    expect(body.version).toBe('')
    expect(body.environment).toBe('')
    for (const c of Object.values(body.checks)) expect(c.detail).toBe('')
  })

  it('gives an anonymous caller empty version and environment when the checks themselves fail', async () => {
    vi.doMock('@/lib/observability/health', async (orig) => ({
      ...(await orig<typeof import('@/lib/observability/health')>()),
      runHealthChecks: async () => {
        throw new Error('boom')
      },
    }))
    const { GET } = await import('@/app/api/health/route')
    const res = await GET(request())
    const body = (await res.json()) as { version: string; environment: string }
    expect(res.status).toBe(503)
    expect(body.version).toBe('')
    expect(body.environment).toBe('')
  })

  it('still tells a caller holding the token the environment on the failure path', async () => {
    vi.doMock('@/lib/observability/health', async (orig) => ({
      ...(await orig<typeof import('@/lib/observability/health')>()),
      runHealthChecks: async () => {
        throw new Error('boom')
      },
    }))
    const { GET } = await import('@/app/api/health/route')
    const res = await GET(request({ 'x-health-token': TOKEN }))
    const body = (await res.json()) as { environment: string }
    expect(res.status).toBe(503)
    expect(body.environment).not.toBe('')
  })
})
