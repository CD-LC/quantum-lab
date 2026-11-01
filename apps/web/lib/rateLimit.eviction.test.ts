/**
 * The in-memory limiters must evict, not clear, when full: a flush hands every
 * caller a fresh allowance, including on the 24-hour LLM cost quotas that share
 * the same map.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests, callerKey, rateLimit } from '@/lib/rateLimit'
import { check, clientKey, resetAll } from '@/lib/security/ratelimit'

const DAY = 86_400_000

beforeEach(() => {
  for (const v of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) {
    delete process.env[v]
  }
  __resetRateLimitForTests()
  resetAll()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetRateLimitForTests()
  resetAll()
})

describe('lib/rateLimit.ts in-memory overflow', () => {
  it('keeps an exhausted daily quota exhausted after the map overflows with minute keys', async () => {
    const t0 = 1_000_000_000_000
    const quota = { limit: 3, windowMs: DAY }
    const key = 'agent-day:u:alice'
    for (let i = 0; i < 3; i++) expect((await rateLimit(key, quota, t0)).allowed).toBe(true)
    expect((await rateLimit(key, quota, t0)).allowed).toBe(false)

    // Flood well past MAX_KEYS (10 000) with distinct one-minute keys.
    for (let i = 0; i < 25_000; i++) {
      await rateLimit(`flood:${i}`, { limit: 5, windowMs: 60_000 }, t0 + 1_000)
    }

    // The old behaviour (clear()) would have returned allowed: true here.
    expect((await rateLimit(key, quota, t0 + 2_000)).allowed).toBe(false)
  })

  it('still evicts long-window keys as a last resort so memory stays bounded', async () => {
    const t0 = 1_000_000_000_000
    for (let i = 0; i < 12_000; i++) {
      await rateLimit(`day:${i}`, { limit: 2, windowMs: DAY }, t0)
    }
    // The newest key is retained and counted.
    const newest = await rateLimit('day:11999', { limit: 2, windowMs: DAY }, t0)
    expect(newest.remaining).toBe(0)
  })

  it('drops expired windows before touching live ones', async () => {
    const t0 = 1_000_000_000_000
    const live = { limit: 2, windowMs: 3_600_000 }
    await rateLimit('hour:bob', live, t0)
    await rateLimit('hour:bob', live, t0)
    // 10 000 stale minute keys, then time moves on past their window.
    for (let i = 0; i < 10_000; i++) await rateLimit(`old:${i}`, { limit: 5, windowMs: 60_000 }, t0)
    await rateLimit('new', { limit: 5, windowMs: 60_000 }, t0 + 120_000)
    expect((await rateLimit('hour:bob', live, t0 + 120_000)).allowed).toBe(false)
  })
})

describe('lib/security/ratelimit.ts in-memory overflow', () => {
  it('evicts oldest-first on overflow instead of clearing everything', () => {
    const t0 = 1_000_000_000_000
    for (let i = 0; i < 10_500; i++) check(`k${i}`, 5, 60_000, t0)
    // The most recently inserted keys must still be counted: a clear() on
    // overflow would have forgotten the ones inserted just before it.
    // k9990 was counted once before the overflow at 10 000 keys; after four more
    // calls it is at 5, so the next is refused. A clear() would have reset it.
    for (let i = 0; i < 4; i++) check('k9990', 5, 60_000, t0)
    expect(check('k9990', 5, 60_000, t0).allowed).toBe(false)
  })

  it('sweeps expired buckets first', () => {
    const t0 = 1_000_000_000_000
    for (let i = 0; i < 10_000; i++) check(`old${i}`, 5, 1_000, t0)
    check('survivor', 1, 3_600_000, t0 + 5_000)
    expect(check('survivor', 1, 3_600_000, t0 + 5_000).allowed).toBe(false)
  })
})

describe('lib/security/ratelimit.ts clientKey', () => {
  it('collapses IPv6 addresses in the same /64 to one bucket', () => {
    const a = clientKey(new Headers({ 'cf-connecting-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }), 'p')
    const b = clientKey(new Headers({ 'cf-connecting-ip': '2001:0db8:1:2:1:2:3:4' }), 'p')
    expect(a).toBe(b)
    expect(a).toBe(callerKey(new Headers({ 'cf-connecting-ip': '2001:db8:1:2::1' }), 'p').replace('p:ip:', 'p:'))
  })

  it('separates different /64s and leaves IPv4 untouched', () => {
    const a = clientKey(new Headers({ 'cf-connecting-ip': '2001:db8:1:2::1' }), 'p')
    const b = clientKey(new Headers({ 'cf-connecting-ip': '2001:db8:1:3::1' }), 'p')
    expect(a).not.toBe(b)
    expect(clientKey(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), 'p')).toBe('p:203.0.113.9')
    expect(clientKey(new Headers(), 'p')).toBe('p:unknown')
  })
})
