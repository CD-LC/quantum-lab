/**
 * POST /api/circuits — the saved-circuit ceiling must hold under a burst.
 * The count-then-insert is serialised per account, so concurrent saves from
 * one Free account cannot all read the same count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rateLimit'

const rows: { user_id: string }[] = []
const MAX = 3

vi.mock('@/lib/security/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/auth')>('@/lib/security/auth')
  return { ...actual, verifiedCallerId: async () => 'user-1' }
})

vi.mock('@/lib/billing/entitlements', () => ({
  getEntitlement: async () => ({ planId: 'free' }),
  getServiceSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: async (_c: string, id: string) => {
          // Yield so concurrent requests interleave if not serialised.
          await new Promise((r) => setTimeout(r, 5))
          return { count: rows.filter((r) => r.user_id === id).length, error: null }
        },
      }),
      insert: (row: { user_id: string }) => ({
        select: () => ({
          single: async () => {
            await new Promise((r) => setTimeout(r, 5))
            rows.push(row)
            return { data: row, error: null }
          },
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/plans', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plans')>('@/lib/plans')
  return { ...actual, limitsFor: () => ({ maxSavedCircuits: MAX }) }
})

const { POST } = await import('@/app/api/circuits/route')

let ip = 0
function save(): Request {
  ip += 1
  return new Request('http://app.test/api/circuits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${ip}` },
    body: JSON.stringify({ name: 'c', qasm: 'OPENQASM 2.0;', numQubits: 2 }),
  })
}

beforeEach(() => {
  rows.length = 0
  __resetRateLimitForTests()
})

describe('POST /api/circuits', () => {
  it('concurrent saves cannot exceed the plan limit', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => POST(save())))
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 201)).toHaveLength(MAX)
    expect(statuses.filter((s) => s === 403)).toHaveLength(8 - MAX)
    expect(rows).toHaveLength(MAX)
  })
})
