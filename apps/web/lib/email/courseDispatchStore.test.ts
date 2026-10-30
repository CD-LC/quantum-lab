/**
 * The Supabase dispatch store's QUERY — specifically, that it asks the
 * database for due subscribers only.
 *
 * The orchestration tests (courseDispatch.test.ts) inject a fake store, so
 * they cannot catch the defect this file exists for: listCandidates used to
 * select the `limit` OLDEST confirmed, unfinished rows regardless of whether
 * anything was due. Once more than `limit` learners were mid-course, the same
 * caught-up rows filled every pass and every newer subscriber got nothing for
 * days. The fix is a database-side due filter, and what is pinned here is
 *   1. the filter is actually attached to the query, and
 *   2. the filter agrees with courseSchedule.dueCourseDay for every row shape.
 *
 * getServiceSupabase is replaced with a recorder that captures the builder
 * chain and yields a canned result, so no live database is involved.
 */

import { describe, expect, it, vi } from 'vitest'

interface Recorded {
  method: string
  args: unknown[]
}

const recorded: Recorded[] = []
let canned: { data: unknown; error: unknown } = { data: [], error: null }

/** A thenable, chainable stand-in for a supabase-js query builder. */
function chain(): unknown {
  const target: Record<string | symbol, unknown> = {}
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(canned).then(resolve, reject)
      }
      return (...args: unknown[]) => {
        recorded.push({ method: String(prop), args })
        return proxy
      }
    },
  })
  return proxy
}

vi.mock('@/lib/billing/entitlements', () => ({
  isServiceRoleConfigured: true,
  getServiceSupabase: () => ({
    from: (table: string) => {
      recorded.push({ method: 'from', args: [table] })
      return chain()
    },
  }),
}))

const { courseDueFilter, supabaseDispatchStore } = await import('@/lib/email/courseDispatch')
const { COURSE_DAY_MS, dueCourseDay } = await import('@/lib/email/courseSchedule')

const NOW = new Date('2026-08-10T09:00:00.000Z')

/**
 * Evaluate the PostgREST `or` string the way Postgres would — the clauses are
 * `and(sent_days.not.cs.{N},confirmed_at.lte.<iso>)`, and the row matches when
 * ANY clause does. Parsing it here, rather than trusting its shape, is the
 * point of the agreement test below.
 */
function matchesDueFilter(filter: string, row: { confirmedAt: string; sentDays: number[] }): boolean {
  const clauses = [...filter.matchAll(/and\(sent_days\.not\.cs\.\{(\d+)\},confirmed_at\.lte\.([^,)]+)\)/g)]
  expect(clauses.length).toBeGreaterThan(0)
  return clauses.some(([, day, dueAt]) => {
    const n = Number(day)
    return !row.sentDays.includes(n) && Date.parse(row.confirmedAt) <= Date.parse(dueAt)
  })
}

describe('courseDueFilter', () => {
  it('is one clause per course day, each demanding the day is unsent AND its date has come', () => {
    const filter = courseDueFilter(NOW)
    const clauses = filter.split('),and(')
    expect(clauses).toHaveLength(7)
    expect(filter).toContain('and(sent_days.not.cs.{1},confirmed_at.lte.2026-08-10T09:00:00.000Z)')
    expect(filter).toContain('and(sent_days.not.cs.{7},confirmed_at.lte.2026-08-04T09:00:00.000Z)')
    // No PostgREST-significant characters leak in from the timestamps.
    expect(filter).not.toMatch(/[ "']/)
  })

  it('agrees with dueCourseDay for every elapsed time and every sent_days prefix', () => {
    const filter = courseDueFilter(NOW)
    for (let hours = -2; hours <= 8 * 24; hours += 5) {
      const confirmedAt = new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString()
      for (let sent = 0; sent <= 7; sent += 1) {
        const sentDays = Array.from({ length: sent }, (_, i) => i + 1)
        const expected = dueCourseDay({ confirmedAt, unsubscribedAt: null, sentDays }, NOW) !== null
        expect(matchesDueFilter(filter, { confirmedAt, sentDays }), `hours=${hours} sent=${sent}`).toBe(
          expected
        )
      }
    }
  })

  it('excludes caught-up rows so they cannot crowd a due subscriber out of the batch', () => {
    const filter = courseDueFilter(NOW)
    // 26 learners confirmed yesterday who already have day 2 — nothing due for
    // them until tomorrow. Under the old query these 26 were the batch.
    const caughtUp = Array.from({ length: 26 }, (_, i) => ({
      confirmedAt: new Date(NOW.getTime() - COURSE_DAY_MS - (i + 1) * 60_000).toISOString(),
      sentDays: [1, 2],
    }))
    // One learner who confirmed a minute ago and has had nothing.
    const due = { confirmedAt: new Date(NOW.getTime() - 60_000).toISOString(), sentDays: [] }

    expect(caughtUp.filter((row) => matchesDueFilter(filter, row))).toHaveLength(0)
    expect(matchesDueFilter(filter, due)).toBe(true)
  })
})

describe('supabaseDispatchStore.listCandidates', () => {
  it('attaches the due filter to the query and still orders oldest-first within the limit', async () => {
    recorded.length = 0
    canned = {
      data: [
        {
          id: 'sub-1',
          email: 'learner@example.com',
          confirmed_at: '2026-08-10T08:00:00.000Z',
          unsubscribed_at: null,
          sent_days: [],
          course_unsubscribe_token: null,
        },
      ],
      error: null,
    }

    const rows = await supabaseDispatchStore.listCandidates(40, NOW)

    expect(rows).toEqual([
      {
        id: 'sub-1',
        email: 'learner@example.com',
        confirmedAt: '2026-08-10T08:00:00.000Z',
        unsubscribedAt: null,
        sentDays: [],
        courseUnsubscribeToken: null,
      },
    ])
    const methods = recorded.map((entry) => entry.method)
    expect(methods).toEqual(['from', 'select', 'eq', 'not', 'is', 'not', 'or', 'order', 'limit'])
    const or = recorded.find((entry) => entry.method === 'or')
    expect(or?.args).toEqual([courseDueFilter(NOW)])
    expect(recorded.find((entry) => entry.method === 'limit')?.args).toEqual([40])
    expect(recorded.find((entry) => entry.method === 'order')?.args).toEqual([
      'confirmed_at',
      { ascending: true },
    ])
  })
})
