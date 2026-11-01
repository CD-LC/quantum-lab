/**
 * The dispatch orchestration, against a fake store and a fake sender.
 *
 * What must stay true, in order of importance:
 *   1. the sent_days claim commits BEFORE the provider is called — the
 *      at-most-once direction (a crash drops mail, never duplicates it);
 *   2. a refused claim (concurrent run, fresh opt-out) sends nothing;
 *   3. a provider failure is reported as a failure, and the claim stands —
 *      the day is a visible gap, not a retry into a double-send;
 *   4. at most one message per subscription per pass.
 */

import { describe, expect, it } from 'vitest'

import {
  runCourseDispatch,
  type ClaimResult,
  type CourseCandidate,
  type CourseDispatchStore,
} from '@/lib/email/courseDispatch'
import type { SendEmailInput, SendResult } from '@/lib/email/client'

const CONFIRMED = '2026-08-01T07:00:00.000Z'
const NOW = new Date('2026-08-03T09:00:00.000Z') // days 1–3 due by the calendar

function candidate(overrides: Partial<CourseCandidate> = {}): CourseCandidate {
  return {
    id: 'sub-1',
    email: 'learner@example.com',
    confirmedAt: CONFIRMED,
    unsubscribedAt: null,
    sentDays: [],
    courseUnsubscribeToken: null,
    ...overrides,
  }
}

/**
 * A fake store that records the ORDER of everything, which is the point:
 * the tests below assert on `fake.log`, not just on counts.
 */
function fakeStore(candidates: CourseCandidate[], claimResult?: ClaimResult) {
  const log: string[] = []
  const store: CourseDispatchStore = {
    async listCandidates(limit) {
      log.push(`list:${limit}`)
      return candidates.slice(0, limit)
    },
    async claimDay(cand, day, freshToken) {
      log.push(`claim:${cand.id}:day${day}`)
      return claimResult ?? { claimed: true, unsubscribeToken: cand.courseUnsubscribeToken ?? freshToken }
    },
  }
  return { store, log }
}

function fakeSend(log: string[], result: SendResult = { sent: true, id: 'msg_1' }) {
  const sent: SendEmailInput[] = []
  return {
    sent,
    send: async (input: SendEmailInput): Promise<SendResult> => {
      log.push(`send:${input.to}`)
      sent.push(input)
      return result
    },
  }
}

describe('runCourseDispatch', () => {
  it('claims the day BEFORE calling the provider, and sends the due day', async () => {
    const { store, log } = fakeStore([candidate({ sentDays: [1] })])
    const sender = fakeSend(log)

    const report = await runCourseDispatch({
      limit: 10,
      baseUrl: 'https://app.test/',
      now: NOW,
      store,
      send: sender.send,
    })

    expect(log).toEqual(['list:10', 'claim:sub-1:day2', 'send:learner@example.com'])
    expect(report).toMatchObject({ examined: 1, sent: 1, notDue: 0, lostClaims: 0 })
    // The message is day 2's, with a working absolute unsubscribe link first.
    const message = sender.sent[0]
    expect(message.subject).toBe('The most common explanation of a qubit is wrong')
    expect(message.text.split('\n')[0]).toMatch(
      /^Unsubscribe \(one click\): https:\/\/app\.test\/api\/email\/unsubscribe\/course\?token=[0-9a-f]{64}$/
    )
  })

  it('reuses an existing unsubscribe token so earlier mails keep working links', async () => {
    const { store, log } = fakeStore([
      candidate({ sentDays: [1], courseUnsubscribeToken: 'a'.repeat(64) }),
    ])
    const sender = fakeSend(log)
    await runCourseDispatch({ limit: 5, baseUrl: 'https://app.test', now: NOW, store, send: sender.send })
    expect(sender.sent[0].text).toContain(`token=${'a'.repeat(64)}`)
  })

  it('a refused claim sends nothing — the concurrent-run/fresh-opt-out guard', async () => {
    const { store, log } = fakeStore([candidate()], { claimed: false })
    const sender = fakeSend(log)
    const report = await runCourseDispatch({
      limit: 5,
      baseUrl: 'https://app.test',
      now: NOW,
      store,
      send: sender.send,
    })
    expect(report).toMatchObject({ examined: 1, sent: 0, lostClaims: 1 })
    expect(log).toEqual(['list:5', 'claim:sub-1:day1']) // no send: entry
  })

  it('a provider failure is a recorded gap, never a retry in the same pass', async () => {
    const { store, log } = fakeStore([candidate()])
    const sender = fakeSend(log, { sent: false, reason: 'provider down' })
    const report = await runCourseDispatch({
      limit: 5,
      baseUrl: 'https://app.test',
      now: NOW,
      store,
      send: sender.send,
    })
    expect(report.sent).toBe(0)
    expect(report.failures).toEqual([{ subscriptionId: 'sub-1', day: 1, reason: 'provider down' }])
    expect(log.filter((entry) => entry.startsWith('send:'))).toHaveLength(1)
  })

  it('skips rows with nothing due and sends at most one message per subscription', async () => {
    const { store, log } = fakeStore([
      candidate({ id: 'caught-up', sentDays: [1, 2, 3] }), // days 1–3 due, all sent
      candidate({ id: 'behind', email: 'behind@example.com', sentDays: [] }),
    ])
    const sender = fakeSend(log)
    const report = await runCourseDispatch({
      limit: 5,
      baseUrl: 'https://app.test',
      now: NOW,
      store,
      send: sender.send,
    })
    expect(report).toMatchObject({ examined: 2, sent: 1, notDue: 1 })
    // The behind subscriber got exactly day 1 — the backlog drains one per pass.
    expect(log.filter((entry) => entry.startsWith('claim:'))).toEqual(['claim:behind:day1'])
  })

  it('honours the batch limit', async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      candidate({ id: `sub-${index}`, email: `learner${index}@example.com` })
    )
    const { store, log } = fakeStore(many)
    const sender = fakeSend(log)
    const report = await runCourseDispatch({
      limit: 3,
      baseUrl: 'https://app.test',
      now: NOW,
      store,
      send: sender.send,
      sleep: async () => {},
    })
    expect(report.examined).toBe(3)
    expect(report.sent).toBe(3)
  })

  describe('transient provider failures', () => {
    function scriptedSend(log: string[], script: SendResult[]) {
      let i = 0
      return async (input: SendEmailInput): Promise<SendResult> => {
        log.push(`send:${input.to}`)
        return script[Math.min(i++, script.length - 1)]
      }
    }

    it('retries a 429/5xx with backoff and the day stays claimed on success', async () => {
      const { store, log } = fakeStore([candidate()])
      const sleeps: number[] = []
      const report = await runCourseDispatch({
        limit: 1,
        baseUrl: 'https://app.test',
        now: NOW,
        store,
        send: scriptedSend(log, [
          { sent: false, reason: 'rate limited', retryable: true },
          { sent: true, id: 'msg_2' },
        ]),
        sleep: async (ms) => void sleeps.push(ms),
      })
      expect(report).toMatchObject({ sent: 1, failures: [] })
      expect(log.filter((e) => e.startsWith('send:'))).toHaveLength(2)
      expect(sleeps).toEqual([1_000])
    })

    it('releases the claim when the provider keeps refusing, so the next pass resends', async () => {
      const { store, log } = fakeStore([candidate()])
      store.releaseDay = async (cand, day) => void log.push(`release:${cand.id}:day${day}`)
      const report = await runCourseDispatch({
        limit: 1,
        baseUrl: 'https://app.test',
        now: NOW,
        store,
        send: scriptedSend(log, [{ sent: false, reason: 'down', retryable: true }]),
        sleep: async () => {},
      })
      expect(report.sent).toBe(0)
      expect(report.failures).toEqual([
        { subscriptionId: 'sub-1', day: 1, reason: 'down', released: true },
      ])
      expect(log.at(-1)).toBe('release:sub-1:day1')
      expect(log.filter((e) => e.startsWith('send:'))).toHaveLength(3)
    })

    it('keeps the claim (no retry, no release) for an ambiguous failure', async () => {
      const { store, log } = fakeStore([candidate()])
      store.releaseDay = async () => void log.push('release')
      const report = await runCourseDispatch({
        limit: 1,
        baseUrl: 'https://app.test',
        now: NOW,
        store,
        send: scriptedSend(log, [{ sent: false, reason: 'socket hang up' }]),
        sleep: async () => {},
      })
      expect(report.failures).toHaveLength(1)
      expect(report.failures[0].released).toBeUndefined()
      expect(log).not.toContain('release')
      expect(log.filter((e) => e.startsWith('send:'))).toHaveLength(1)
    })

    it('paces consecutive sends', async () => {
      const { store, log } = fakeStore([
        candidate({ id: 'a', email: 'a@example.com' }),
        candidate({ id: 'b', email: 'b@example.com' }),
      ])
      const sleeps: number[] = []
      await runCourseDispatch({
        limit: 2,
        baseUrl: 'https://app.test',
        now: NOW,
        store,
        send: fakeSend(log).send,
        sleep: async (ms) => void sleeps.push(ms),
      })
      expect(sleeps).toEqual([500])
    })
  })
})
