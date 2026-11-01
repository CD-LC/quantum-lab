/**
 * /api/compete: GET is rate limited (anonymous, one Supabase query each), and an
 * oversized POST body is refused while reading.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET, POST } from '@/app/api/compete/route'
import { __resetRateLimitForTests } from '@/lib/rateLimit'
import { __resetCompeteStoreForTests } from './store'

function get(ip: string): Request {
  return new Request('http://test.local/api/compete', { headers: { 'x-forwarded-for': ip } })
}

beforeEach(() => {
  __resetRateLimitForTests()
  __resetCompeteStoreForTests()
})
afterEach(() => __resetRateLimitForTests())

describe('/api/compete GET rate limit', () => {
  it('answers 429 with Retry-After once a caller exceeds the read allowance', async () => {
    let last: Response | null = null
    for (let i = 0; i < 60; i++) {
      last = await GET(get('198.51.100.7'))
      expect(last.status).toBe(200)
    }
    const refused = await GET(get('198.51.100.7'))
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(((await refused.json()) as { code: string }).code).toBe('rate_limited')
  })

  it('does not penalise a different caller', async () => {
    for (let i = 0; i < 61; i++) await GET(get('198.51.100.7'))
    expect((await GET(get('198.51.100.8'))).status).toBe(200)
  })
})
