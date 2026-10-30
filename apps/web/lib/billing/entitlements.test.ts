/**
 * entitlements.test.ts — org-seat resolution and the usage meter.
 *
 * FAKED: the Supabase client (in-memory tables with the handful of query
 * methods entitlements.ts uses). Real: the resolution rules.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const db = vi.hoisted(() => {
  const state = {
    subscriptions: [] as Row[],
    org_members: [] as Row[],
    orgs: [] as Row[],
    hardware_usage: [] as Row[],
    /** Simulate a project that has not applied schema-byok.sql. */
    noCredentialOwnerColumn: false,
    usageQueries: [] as string[][],
  }
  function table(name: keyof typeof state) {
    const q = {
      eqs: [] as Array<[string, unknown]>,
      ins: [] as Array<[string, unknown[]]>,
      head: false,
    }
    function run(mode: 'many' | 'maybe'): Promise<unknown> {
      if (name === 'hardware_usage') {
        state.usageQueries.push(q.eqs.map(([c]) => c))
        if (state.noCredentialOwnerColumn && q.eqs.some(([c]) => c === 'credential_owner')) {
          return Promise.resolve({
            data: null,
            count: null,
            error: { code: '42703', message: 'column hardware_usage.credential_owner does not exist' },
          })
        }
      }
      const all = state[name] as unknown as Row[]
      const hits = all.filter(
        (r) =>
          q.eqs.every(([c, v]) => r[c] === v) && q.ins.every(([c, vs]) => vs.includes(r[c]))
      )
      if (q.head) return Promise.resolve({ data: null, error: null, count: hits.length })
      if (mode === 'maybe') return Promise.resolve({ data: hits[0] ?? null, error: null })
      return Promise.resolve({ data: hits, error: null, count: hits.length })
    }
    const api = {
      select(_c?: string, opts?: { head?: boolean }) {
        if (opts?.head) q.head = true
        return api
      },
      eq(c: string, v: unknown) {
        q.eqs.push([c, v])
        return api
      },
      in(c: string, vs: unknown[]) {
        q.ins.push([c, vs])
        return api
      },
      gte: () => api,
      maybeSingle: () => run('maybe'),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run('many').then(res, rej),
    }
    return api
  }
  const client = { from: (name: string) => table(name as keyof typeof state), auth: { admin: {} } }
  return { state, client }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => db.client }))
vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: true, getSupabase: () => db.client }))

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

const { getEntitlement } = await import('./entitlements')

const USER = '11111111-1111-4111-8111-111111111111'
const OWNER = '33333333-3333-4333-8333-333333333333'
const ORG = '44444444-4444-4444-8444-444444444444'

function seat(plan: string, status = 'active', org = ORG) {
  db.state.org_members.push({ user_id: USER, org_id: org, plan_id: plan, status })
}
function org(plan: string, owner: string | null = OWNER, id = ORG) {
  db.state.orgs.push({ id, plan_id: plan, owner_id: owner })
}
function ownerSub(over: Row) {
  db.state.subscriptions.push({
    user_id: OWNER,
    stripe_customer_id: 'cus_o',
    stripe_subscription_id: 'sub_o',
    plan_id: 'team',
    status: 'active',
    ...over,
  })
}

beforeEach(() => {
  db.state.subscriptions.length = 0
  db.state.org_members.length = 0
  db.state.orgs.length = 0
  db.state.hardware_usage.length = 0
  db.state.noCredentialOwnerColumn = false
  db.state.usageQueries.length = 0
})

describe('org seats and the owner’s subscription', () => {
  it('keeps a seat in a Team org whose owner pays for Team', async () => {
    org('team')
    ownerSub({ plan_id: 'team', status: 'active' })
    seat('team')
    const e = await getEntitlement(USER)
    expect(e.planId).toBe('team')
    expect(e.viaOrgId).toBe(ORG)
  })

  it('lapses a Team org whose owner moved to Pro', async () => {
    org('team')
    ownerSub({ plan_id: 'pro', status: 'active' })
    seat('team')
    const e = await getEntitlement(USER)
    expect(e.planId).toBe('free')
    expect(e.viaOrgId).toBeUndefined()
  })

  it('lapses a Team org whose owner cancelled and bought Pro, or reconciled to free', async () => {
    org('team')
    seat('team')
    ownerSub({ plan_id: 'free', status: 'canceled' })
    expect((await getEntitlement(USER)).planId).toBe('free')
  })

  it('lapses a Team org whose owner cancelled Team', async () => {
    org('team')
    ownerSub({ plan_id: 'team', status: 'canceled' })
    seat('team')
    expect((await getEntitlement(USER)).planId).toBe('free')
  })

  it('does not lapse a hand-provisioned org (no Stripe link on the owner row)', async () => {
    org('team')
    ownerSub({ plan_id: 'pro', status: 'active', stripe_customer_id: null, stripe_subscription_id: null })
    seat('team')
    expect((await getEntitlement(USER)).planId).toBe('team')
  })

  it('does not lapse a hand-provisioned org whose owner has no subscription row', async () => {
    org('edu')
    seat('edu')
    expect((await getEntitlement(USER)).planId).toBe('edu')
  })

  it('does not lapse a University org because its owner has a personal Pro subscription', async () => {
    org('edu')
    ownerSub({ plan_id: 'pro', status: 'active' })
    seat('edu')
    expect((await getEntitlement(USER)).planId).toBe('edu')
  })
})

describe('personal subscription versus seat', () => {
  it('lets a good Team seat win over a canceled personal Team row', async () => {
    db.state.subscriptions.push({
      user_id: USER,
      plan_id: 'team',
      status: 'canceled',
      current_period_end: '2020-01-01T00:00:00.000Z',
    })
    org('team')
    ownerSub({ plan_id: 'team', status: 'active' })
    seat('team')

    const e = await getEntitlement(USER)

    expect(e.planId).toBe('team')
    expect(e.status).toBe('active')
    expect(e.viaOrgId).toBe(ORG)
  })

  it('keeps a good personal plan when the seat is not stronger', async () => {
    db.state.subscriptions.push({ user_id: USER, plan_id: 'team', status: 'active' })
    org('team')
    ownerSub({ plan_id: 'team', status: 'active' })
    seat('team')

    const e = await getEntitlement(USER)

    expect(e.planId).toBe('team')
    expect(e.viaOrgId).toBeUndefined()
  })

  it('still lets a stronger seat beat a good personal plan', async () => {
    db.state.subscriptions.push({ user_id: USER, plan_id: 'pro', status: 'active' })
    org('team')
    ownerSub({ plan_id: 'team', status: 'active' })
    seat('team')
    expect((await getEntitlement(USER)).planId).toBe('team')
  })

  it('leaves a canceled personal row alone when there is no seat', async () => {
    db.state.subscriptions.push({ user_id: USER, plan_id: 'team', status: 'canceled' })
    const e = await getEntitlement(USER)
    expect(e.planId).toBe('team')
    expect(e.status).toBe('canceled')
  })
})

describe('the usage meter', () => {
  const recent = new Date().toISOString()

  it('counts only operator-funded jobs, as the quota function does', async () => {
    db.state.hardware_usage.push(
      { user_id: USER, credential_owner: 'operator', created_at: recent },
      { user_id: USER, credential_owner: 'operator', created_at: recent },
      { user_id: USER, credential_owner: 'user', created_at: recent },
      { user_id: USER, credential_owner: 'user', created_at: recent }
    )
    expect((await getEntitlement(USER)).hardwareJobsUsed).toBe(2)
  })

  it('falls back to every row when the column does not exist yet', async () => {
    db.state.noCredentialOwnerColumn = true
    db.state.hardware_usage.push(
      { user_id: USER, created_at: recent },
      { user_id: USER, created_at: recent },
      { user_id: USER, created_at: recent }
    )

    expect((await getEntitlement(USER)).hardwareJobsUsed).toBe(3)
    // Filtered attempt first, then the plain one.
    expect(db.state.usageQueries.at(-2)).toContain('credential_owner')
    expect(db.state.usageQueries.at(-1)).not.toContain('credential_owner')
  })
})
