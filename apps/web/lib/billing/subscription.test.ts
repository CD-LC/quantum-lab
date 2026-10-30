/**
 * subscription.test.ts — the Stripe status → our status mapping.
 */

import { describe, expect, it } from 'vitest'
import { toStatus } from './subscription'
import { effectivePlan } from '@/lib/plans'

describe('toStatus', () => {
  it('keeps the statuses that entitle', () => {
    expect(toStatus('active')).toBe('active')
    expect(toStatus('trialing')).toBe('trialing')
    expect(toStatus('past_due')).toBe('past_due')
  })

  it('treats unpaid as the end of the subscription, not as dunning grace', () => {
    // Stripe `unpaid`: retries are over and nothing will be charged again.
    expect(toStatus('unpaid')).toBe('canceled')
  })

  it('an unpaid subscription falls back to the Free plan', () => {
    const plan = effectivePlan({
      planId: 'pro',
      status: toStatus('unpaid'),
    } as Parameters<typeof effectivePlan>[0])
    expect(plan.id).toBe('free')
  })
})
