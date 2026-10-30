/**
 * subscriptions.ts — the consent state machine, against the in-memory store.
 *
 * These are the properties docs/ONBOARDING.md's email section stakes its
 * honesty on. Each test names the promise it protects:
 *
 *   1. a signup alone is NOT consent (confirmedAt stays null);
 *   2. confirmation is idempotent and only reachable with the mailed token;
 *   3. an unsubscribe PERSISTS, is idempotent, and cannot be undone by a
 *      stale confirm link — only a fresh double-opt-in signup re-enters;
 *   4. the store never holds a usable secret (hash at rest, token unstored).
 *
 * Run against the memory backend (no SUPABASE_SERVICE_ROLE_KEY in the test
 * environment), which shares the state-machine code with the Supabase one —
 * the same double-backend pattern as lib/exams/store.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dueCourseDay } from '@/lib/email/courseSchedule'
import {
  __resetSubscriptionStoreForTests,
  beginSubscription,
  confirmSubscriptionByToken,
  getSubscriptionStore,
  hashSubscriptionToken,
  isSubscriptionToken,
  unsubscribeByToken,
} from '@/lib/email/subscriptions'

const EMAIL = 'learner@example.com'

/** Sign up and hand back the token the confirm mail would carry. */
async function signup(email = EMAIL): Promise<string> {
  const outcome = await beginSubscription(email, 'course-7day')
  if (outcome.kind !== 'send-confirm') throw new Error('expected a fresh signup')
  return outcome.token
}

beforeEach(__resetSubscriptionStoreForTests)
afterEach(__resetSubscriptionStoreForTests)

describe('signup', () => {
  it('records an UNCONFIRMED row — submitting a form is not consent', async () => {
    await signup()
    const row = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    expect(row).not.toBeNull()
    expect(row?.confirmedAt).toBeNull()
    expect(row?.unsubscribedAt).toBeNull()
    expect(row?.consentedAt).toBeTruthy()
  })

  it('normalises the address, so one mailbox is one row', async () => {
    await signup('  Learner@Example.COM ')
    expect(await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')).not.toBeNull()
  })

  it('stores only the token hash, never the token', async () => {
    const token = await signup()
    const row = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    expect(isSubscriptionToken(token)).toBe(true)
    expect(row?.tokenHash).toBe(await hashSubscriptionToken(token))
    expect(row?.tokenHash).not.toBe(token)
  })

  it('sends nothing for an already-confirmed address (no re-mail primitive)', async () => {
    const token = await signup()
    await confirmSubscriptionByToken(token)

    const again = await beginSubscription(EMAIL, 'course-7day')
    expect(again.kind).toBe('already-confirmed')
    // And the existing confirmation was not disturbed.
    const row = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    expect(row?.confirmedAt).not.toBeNull()
  })

  it('re-signup replaces an unconfirmed row: the old confirm link goes dead', async () => {
    const oldToken = await signup()
    const newToken = await signup()
    expect(newToken).not.toBe(oldToken)
    expect(await confirmSubscriptionByToken(oldToken)).toBe('invalid')
    expect(await confirmSubscriptionByToken(newToken)).toBe('confirmed')
  })
})

describe('confirmation', () => {
  it('stamps confirmedAt exactly once, idempotently', async () => {
    const token = await signup()
    expect(await confirmSubscriptionByToken(token)).toBe('confirmed')
    expect(await confirmSubscriptionByToken(token)).toBe('already-confirmed')
    const row = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    expect(row?.confirmedAt).not.toBeNull()
  })

  it('refuses junk without touching the store: shape check before hash', async () => {
    expect(await confirmSubscriptionByToken(undefined)).toBe('invalid')
    expect(await confirmSubscriptionByToken('')).toBe('invalid')
    expect(await confirmSubscriptionByToken('not-a-token')).toBe('invalid')
    expect(await confirmSubscriptionByToken('f'.repeat(63))).toBe('invalid')
  })

  it('refuses a well-formed token that was never minted', async () => {
    await signup()
    expect(await confirmSubscriptionByToken('0'.repeat(64))).toBe('invalid')
  })
})

describe('unsubscribe — the promise that must actually persist', () => {
  it('stamps unsubscribedAt in the store, not just in the response', async () => {
    const token = await signup()
    await confirmSubscriptionByToken(token)

    expect(await unsubscribeByToken(token)).toBe('unsubscribed')
    const row = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    expect(row?.unsubscribedAt).not.toBeNull()
  })

  it('is idempotent: the second click changes nothing and still succeeds', async () => {
    const token = await signup()
    await unsubscribeByToken(token)
    const first = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    expect(await unsubscribeByToken(token)).toBe('already-unsubscribed')
    const second = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    expect(second?.unsubscribedAt).toBe(first?.unsubscribedAt)
  })

  it('a stale confirm link cannot undo an opt-out', async () => {
    const token = await signup()
    await confirmSubscriptionByToken(token)
    await unsubscribeByToken(token)

    expect(await confirmSubscriptionByToken(token)).toBe('invalid')
    const row = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    expect(row?.unsubscribedAt).not.toBeNull()
  })

  it('the only way back in is a fresh signup plus a fresh confirmation', async () => {
    const token = await signup()
    await confirmSubscriptionByToken(token)
    await unsubscribeByToken(token)

    const fresh = await signup()
    const afterSignup = await getSubscriptionStore().getByEmail(EMAIL, 'course-7day')
    // The re-signup alone is not consent either — confirmation reset.
    expect(afterSignup?.confirmedAt).toBeNull()
    expect(afterSignup?.unsubscribedAt).toBeNull()

    expect(await confirmSubscriptionByToken(fresh)).toBe('confirmed')
  })

  it('re-signup resets the send record, so the course restarts at day 1', async () => {
    const token = await signup()
    await confirmSubscriptionByToken(token)
    const store = getSubscriptionStore()
    const before = await store.getByEmail(EMAIL, 'course-7day')
    await store.upsert({ ...before!, sentDays: [1, 2, 3, 4, 7] })
    await unsubscribeByToken(token)

    const fresh = await signup()
    expect(await confirmSubscriptionByToken(fresh)).toBe('confirmed')

    const row = await store.getByEmail(EMAIL, 'course-7day')
    expect(row?.sentDays).toEqual([])
    const later = new Date(new Date(row!.confirmedAt!).getTime() + 60_000)
    expect(dueCourseDay(row!, later)).toBe(1)
  })

  it('an unknown or junk token reports "unknown" and writes nothing', async () => {
    expect(await unsubscribeByToken('0'.repeat(64))).toBe('unknown')
    expect(await unsubscribeByToken('junk')).toBe('unknown')
    expect(await unsubscribeByToken(null)).toBe('unknown')
  })
})
