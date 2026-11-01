/**
 * The wall-clock budget: once spent, no new day is claimed or sent, the rest
 * of the batch is reported as remaining, and a claim is never left unsent.
 */
import { describe, expect, it } from 'vitest'

import {
  DISPATCH_BUDGET_MS,
  runCourseDispatch,
  type CourseCandidate,
  type CourseDispatchStore,
} from '@/lib/email/courseDispatch'
import type { SendEmailInput, SendResult } from '@/lib/email/client'

const NOW = new Date('2026-08-03T09:00:00.000Z')

function candidates(n: number): CourseCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `sub-${i}`,
    email: `l${i}@example.com`,
    confirmedAt: '2026-08-01T07:00:00.000Z',
    unsubscribedAt: null,
    sentDays: [],
    courseUnsubscribeToken: null,
  }))
}

function harness(n: number) {
  const log: string[] = []
  const store: CourseDispatchStore = {
    async listCandidates() {
      return candidates(n)
    },
    async claimDay(cand, day, token) {
      log.push(`claim:${cand.id}`)
      return { claimed: true, unsubscribeToken: token }
    },
  }
  let t = 0
  const send = async (input: SendEmailInput): Promise<SendResult> => {
    log.push(`send:${input.to}`)
    t += 10_000 // each send "takes" 10 s of wall clock
    return { sent: true, id: 'm' }
  }
  return { store, log, send, clock: () => t }
}

describe('runCourseDispatch wall-clock budget', () => {
  it('defaults to about a minute, inside the cron timeout', () => {
    expect(DISPATCH_BUDGET_MS).toBeLessThanOrEqual(60_000)
  })

  it('stops starting sends once the budget is spent and reports what remains', async () => {
    const h = harness(10)
    const report = await runCourseDispatch({
      limit: 10,
      baseUrl: 'https://app.test',
      now: NOW,
      store: h.store,
      send: h.send,
      sleep: async () => undefined,
      clock: h.clock,
      budgetMs: 35_000,
    })
    // Sends begin at t=0,10,20,30 (<35 s); the fifth would start at 40 s.
    expect(report.sent).toBe(4)
    expect(report.examined).toBe(4)
    expect(report.remaining).toBe(6)
    // Every claim was followed by its send: no claimed-but-unsent day.
    const claims = h.log.filter((l) => l.startsWith('claim:')).length
    const sends = h.log.filter((l) => l.startsWith('send:')).length
    expect(claims).toBe(sends)
    expect(h.log.some((l) => l === 'claim:sub-4')).toBe(false)
  })

  it('reports zero remaining when the whole batch fits in the budget', async () => {
    const h = harness(3)
    const report = await runCourseDispatch({
      limit: 3,
      baseUrl: 'https://app.test',
      now: NOW,
      store: h.store,
      send: h.send,
      sleep: async () => undefined,
      clock: h.clock,
    })
    expect(report).toMatchObject({ sent: 3, examined: 3, remaining: 0 })
  })
})
