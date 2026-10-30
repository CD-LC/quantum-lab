import { beforeEach, describe, expect, it } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rateLimit'
import { allowVerifyLookup, decodeCertificateSegment, VERIFY_PAGE_LIMIT } from '@/app/verify/[certificateId]/guard'

describe('decodeCertificateSegment', () => {
  it('passes a normal certificate number through untouched', () => {
    expect(decodeCertificateSegment('QL-4F2AH-9C31T-K')).toBe('QL-4F2AH-9C31T-K')
  })

  it('decodes a still-encoded segment', () => {
    expect(decodeCertificateSegment('QL%2D4F2AH')).toBe('QL-4F2AH')
  })

  it('returns null, never throws, for malformed percent-encoding', () => {
    expect(decodeCertificateSegment('%E0%A4%A')).toBeNull()
    expect(decodeCertificateSegment('%')).toBeNull()
    expect(decodeCertificateSegment('%E0')).toBeNull()
  })
})

describe('allowVerifyLookup', () => {
  beforeEach(() => __resetRateLimitForTests())

  it('allows up to the limit and then refuses, per caller', async () => {
    const a = new Headers({ 'cf-connecting-ip': '203.0.113.9' })
    for (let i = 0; i < VERIFY_PAGE_LIMIT.limit; i++) {
      expect(await allowVerifyLookup(a)).toBe(true)
    }
    expect(await allowVerifyLookup(a)).toBe(false)
    // A different caller is unaffected.
    expect(await allowVerifyLookup(new Headers({ 'cf-connecting-ip': '203.0.113.10' }))).toBe(true)
  })
})
