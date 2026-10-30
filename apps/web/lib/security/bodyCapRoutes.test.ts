/** Routes refuse an oversized body with 413 before buffering it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rateLimit'
import { resetAll } from '@/lib/security/ratelimit'
import { POST as agentPOST } from '@/app/api/agent/route'
import { POST as analyticsPOST } from '@/app/api/analytics/route'

beforeEach(() => {
  __resetRateLimitForTests()
  resetAll()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  __resetRateLimitForTests()
  resetAll()
})

function big(url: string, bytes: number, ip: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ pad: 'x'.repeat(bytes) }),
  })
}

describe('body size caps are enforced while reading', () => {
  it('/api/agent answers 413 for an oversized body', async () => {
    const res = await agentPOST(big('http://test.local/api/agent', 2_000_000, '203.0.113.1'))
    expect(res.status).toBe(413)
  })

  it('/api/analytics answers 413 for an oversized body', async () => {
    const res = await analyticsPOST(big('http://test.local/api/analytics', 2_000_000, '203.0.113.2'))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { code: string }).code).toBe('payload_too_large')
  })

  it('/api/analytics still answers 400 for malformed JSON', async () => {
    const res = await analyticsPOST(
      new Request('http://test.local/api/analytics', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.3' },
        body: '{nope',
      })
    )
    expect(res.status).toBe(400)
  })
})
