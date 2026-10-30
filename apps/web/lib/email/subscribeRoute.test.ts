/**
 * POST /api/email/subscribe — the per-recipient throttle and the non-awaited
 * send. Per-IP limits bound one machine; these bound what any number of
 * machines can do to ONE mailbox, and keep the response time from telling a
 * prober whether an address is already a confirmed subscriber.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rateLimit'
import { __resetSubscriptionStoreForTests, beginSubscription, confirmSubscriptionByToken } from '@/lib/email/subscriptions'

const sent: string[] = []
let sendDelayMs = 0

vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn(async (input: { to: string }) => {
    if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs))
    sent.push(input.to)
    return { sent: true, id: 'msg' }
  }),
}))

const route = await import('@/app/api/email/subscribe/route')

let n = 0
function post(email: string): Promise<Response> {
  n += 1
  return route.POST(
    new Request('https://app.test/api/email/subscribe', {
      method: 'POST',
      // A different source address each time, so only the per-address limit can fire.
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${n}` },
      body: JSON.stringify({ email }),
    })
  )
}

beforeEach(() => {
  sent.length = 0
  sendDelayMs = 0
  __resetRateLimitForTests()
  __resetSubscriptionStoreForTests()
})
afterEach(() => {
  __resetRateLimitForTests()
  __resetSubscriptionStoreForTests()
})

describe('per-recipient throttle', () => {
  it('mails one mailbox at most twice a day, whoever asks, with an identical response', async () => {
    const bodies: unknown[] = []
    for (let i = 0; i < 5; i += 1) {
      const res = await post('target@example.com')
      expect(res.status).toBe(200)
      bodies.push(await res.json())
    }
    await new Promise((r) => setTimeout(r, 10))
    expect(sent.filter((to) => to === 'target@example.com')).toHaveLength(2)
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1)
  })

  it('does not reset an opted-out row once the cap is reached', async () => {
    await post('leaver@example.com')
    await post('leaver@example.com')
    const third = await post('leaver@example.com')
    expect(third.status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toHaveLength(2)
  })

  it('counts addresses case-insensitively', async () => {
    await post('Case@Example.com')
    await post('case@example.com')
    await post('CASE@EXAMPLE.COM')
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toHaveLength(2)
  })
})

describe('response timing', () => {
  it('does not wait for the provider, so a slow send does not show in the response time', async () => {
    sendDelayMs = 300
    const started = Date.now()
    const res = await post('slow@example.com')
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('answers an already-confirmed address identically', async () => {
    const outcome = await beginSubscription('done@example.com', 'course-7day')
    if (outcome.kind !== 'send-confirm') throw new Error('expected a fresh signup')
    await confirmSubscriptionByToken(outcome.token)
    const fresh = await post('fresh@example.com')
    const confirmed = await post('done@example.com')
    expect(await confirmed.json()).toEqual(await fresh.json())
  })
})
