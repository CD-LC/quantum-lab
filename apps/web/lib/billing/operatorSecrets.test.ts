/**
 * operatorSecrets.test.ts — the operator-secret compare must refuse, never throw.
 *
 * `timingSafeEqual` throws a RangeError on buffers of different BYTE length. A
 * header with a multi-byte character and the same CHARACTER count as the secret
 * used to pass a `string.length` guard and turn a refusal into an unthrottled
 * 500 for any anonymous caller.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { secretMatches } from './secretCompare'
import { __resetRateLimitForTests } from '@/lib/rateLimit'

const { POST } = await import('@/app/api/email/dispatch/route')

describe('secretMatches', () => {
  it('accepts only the exact secret', () => {
    expect(secretMatches('s3cret-value', 's3cret-value')).toBe(true)
    expect(secretMatches('s3cret-valuf', 's3cret-value')).toBe(false)
    expect(secretMatches('', 's3cret-value')).toBe(false)
  })

  it('never matches when no secret is configured, even an empty offer', () => {
    expect(secretMatches('', '')).toBe(false)
    expect(secretMatches('anything', '')).toBe(false)
  })

  it('does not throw for equal-length strings of different byte length', () => {
    // 6 characters each; 7 bytes vs 6.
    expect('cafés!'.length).toBe('cafes!'.length)
    expect(() => secretMatches('cafés!', 'cafes!')).not.toThrow()
    expect(secretMatches('cafés!', 'cafes!')).toBe(false)
  })

  it('does not throw for astral characters or very long input', () => {
    expect(secretMatches('\u{1F600}'.repeat(5000), 'x')).toBe(false)
  })
})

describe('POST /api/email/dispatch — secret with multi-byte characters', () => {
  beforeEach(() => {
    process.env.EMAIL_DISPATCH_SECRET = 'dispatch-secret'
    __resetRateLimitForTests()
  })

  it('answers 401, not 500', async () => {
    const offered = 'dispatch-secrét' // same character count as the secret
    expect(offered.length).toBe('dispatch-secret'.length)
    const response = await POST(
      new Request('http://app.test/api/email/dispatch', {
        method: 'POST',
        headers: { authorization: `Bearer ${offered}`, 'x-forwarded-for': '198.51.100.77' },
      })
    )
    expect(response.status).toBe(401)
    delete process.env.EMAIL_DISPATCH_SECRET
  })
})
